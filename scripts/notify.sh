#!/usr/bin/env bash

set -euo pipefail

# -----------------------------------------------------------------------------
# Pi 通知脚本
#
# 职责边界：
# - 输入：仅消费插件传入的环境变量（事件元数据）。
# - 输出：负责通知模板渲染与声音播放。
# - 资源：图标与音频统一从脚本目录下 assets 解析。
# -----------------------------------------------------------------------------

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
ASSET_DIR="$SCRIPT_DIR/assets"
ICON_FILE="$ASSET_DIR/logo.png"
SOUND_FILE="$ASSET_DIR/notify.wav"
WINDOWS_NOTIFY_SCRIPT="$SCRIPT_DIR/notify_windows.ps1"
ACTION_NOTIFY_SCRIPT="$SCRIPT_DIR/notify-action.py"
PULSE_WAKEUP_SLEEP_SEC="${PI_NOTIFY_PULSE_WAKEUP_SLEEP_SEC:-0.12}"

kind="${PI_NOTIFY_KIND:-generic}"
project="${PI_NOTIFY_PROJECT:-}"
session_id="${PI_NOTIFY_SESSION_ID:-}"
session_title="${PI_NOTIFY_SESSION_TITLE:-}"
session_type="${PI_NOTIFY_SESSION_TYPE:-${XDG_SESSION_TYPE:-}}"
current_desktop="${PI_NOTIFY_CURRENT_DESKTOP:-${XDG_CURRENT_DESKTOP:-}}"
desktop_session="${PI_NOTIFY_DESKTOP_SESSION:-${DESKTOP_SESSION:-}}"
tmux_pane="${PI_NOTIFY_TMUX_PANE:-${TMUX_PANE:-}}"
alacritty_window_id="${PI_NOTIFY_ALACRITTY_WINDOW_ID:-${ALACRITTY_WINDOW_ID:-}}"
wt_session="${WT_SESSION:-}"

build_title() {
  # 标题直接体现通知场景目的。
  # 注意：src/notify.ts 当前会发出 session.completed / session.error / permission.requested。
  # question.requested 为预留分支，未知 kind 统一落到 *) 兜底。
  case "$kind" in
    session.completed)
      printf '%s' "Pi - Completed"
      ;;
    question.requested)
      printf '%s' "Pi - Question"
      ;;
    permission.requested)
      printf '%s' "Pi - Permission"
      ;;
    session.error)
      printf '%s' "Pi - Error"
      ;;
    *)
      printf '%s' "Pi - Event"
      ;;
  esac
}

build_message() {
  # 正文格式：有 title 就用 `[project] title`，没 title 就只用 project。
  # 故意不再回退到 session_id（UUID），免得把不可读的标识符当标题渲染。
  local project_display="$project"
  local title_display="$session_title"

  if [[ -z "$project_display" ]]; then
    project_display="untitled"
  fi

  if [[ -z "$title_display" ]]; then
    message="$project_display"
  else
    message="[${project_display}] ${title_display}"
  fi
}

is_wsl() {
  # WSL 兼容环境检测：优先环境变量，其次内核发行标识
  if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    return 0
  fi

  if [[ -r /proc/sys/kernel/osrelease ]] && grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease; then
    return 0
  fi

  return 1
}

can_use_windows_backend() {
  # Windows backend 仅在 WSL + powershell.exe + wslpath + helper 脚本可用时启用
  is_wsl \
    && command -v powershell.exe >/dev/null 2>&1 \
    && command -v wslpath >/dev/null 2>&1 \
    && [[ -f "$WINDOWS_NOTIFY_SCRIPT" ]]
}

detect_notify_backend() {
  # 按系统后端分支执行：windows -> linux -> none
  if can_use_windows_backend; then
    printf '%s' "windows"
    return
  fi

  if command -v notify-send >/dev/null 2>&1; then
    printf '%s' "linux"
    return
  fi

  printf '%s' "none"
}

encode_base64() {
  # 统一编码参数，避免 WSL -> PowerShell 传参与编码歧义
  local value="$1"
  printf '%s' "$value" | base64 | tr -d '\n'
}

send_windows_notification() {
  # WSL 下通过 Windows PowerShell helper 发送带自定义图标的系统通知
  local icon="$1"
  local title="$2"
  local body="$3"
  local tmux_target="$4"
  local tmux_client_tty="$5"
  local tmux_context="$6"
  local win_script=""
  local win_icon=""

  if ! can_use_windows_backend; then
    return 1
  fi

  win_script="$(wslpath -w "$WINDOWS_NOTIFY_SCRIPT")"
  if [[ -f "$icon" ]]; then
    win_icon="$(wslpath -w "$icon")"
  fi

  powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File "$win_script" \
    -TitleBase64 "$(encode_base64 "$title")" \
    -BodyBase64 "$(encode_base64 "$body")" \
    -IconPathBase64 "$(encode_base64 "$win_icon")" \
    -WslDistroBase64 "$(encode_base64 "${WSL_DISTRO_NAME:-}")" \
    -WslNotifyScriptBase64 "$(encode_base64 "$SCRIPT_PATH")" \
    -TmuxTargetBase64 "$(encode_base64 "$tmux_target")" \
    -TmuxClientTtyBase64 "$(encode_base64 "$tmux_client_tty")" \
    -TmuxContextBase64 "$(encode_base64 "$tmux_context")" \
    -WtSessionBase64 "$(encode_base64 "$wt_session")" >/dev/null 2>&1
}

play_linux_sound() {
  # 仅播放本地资源音频，尝试顺序：paplay -> aplay -> ffplay
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return 1
  fi

  if play_with_backend "paplay" "$file"; then
    return 0
  fi
  if play_with_backend "aplay" "$file"; then
    return 0
  fi
  if play_with_backend "ffplay" "$file"; then
    return 0
  fi

  return 1
}

# ------------------------- Jump: tmux -------------------------

notify_error() {
  printf 'Pi notify: %s\n' "$1" >&2
}

TMUX_JUMP_SOCKET=""

tmux_command() {
  # The WSL click runs outside the originating tmux server's environment.
  if [[ -n "$TMUX_JUMP_SOCKET" ]]; then
    tmux -S "$TMUX_JUMP_SOCKET" "$@"
  else
    tmux "$@"
  fi
}

tmux_resolve_target() {
  # Return session|window|pane. Stable targets follow the pane ID, preferring its captured
  # session if the window is linked. Old Windows notifications carry name:index.index.
  # 1 = missing/invalid target, 2 = query failure, 3 = ambiguous linked pane.
  local target="$1" want_pane="" want_session="" legacy_session="" legacy_window="" legacy_pane=""
  local rows pane session window windex pindex name found="" location ambiguous=0

  if [[ "$target" =~ ^(\$[0-9]+):@[0-9]+\.(%[0-9]+)$ ]]; then
    want_session="${BASH_REMATCH[1]}" want_pane="${BASH_REMATCH[2]}"
  elif [[ "$target" =~ ^%[0-9]+$ ]]; then
    want_pane="$target"
  elif [[ "$target" =~ ^([^:]+):([0-9]+)\.([0-9]+)$ ]]; then
    legacy_session="${BASH_REMATCH[1]}" legacy_window="${BASH_REMATCH[2]}" legacy_pane="${BASH_REMATCH[3]}"
  else
    return 1
  fi

  # display-message can fall back to a current pane when its target is gone; list exact IDs.
  rows="$(tmux_command list-panes -a -F '#{pane_id}|#{session_id}|#{window_id}|#{window_index}|#{pane_index}|#{session_name}')" || return 2
  while IFS='|' read -r pane session window windex pindex name; do
    if [[ -n "$want_pane" ]]; then
      [[ "$pane" == "$want_pane" ]] || continue
      location="$session|$window|$pane"
      if [[ "$session" == "$want_session" ]]; then
        printf '%s' "$location"
        return
      fi
      if [[ -n "$found" && "$found" != "$location" ]]; then
        ambiguous=1
      fi
      found="$location"
    elif [[ "$name" == "$legacy_session" && "$windex" == "$legacy_window" && "$pindex" == "$legacy_pane" ]]; then
      printf '%s|%s|%s' "$session" "$window" "$pane"
      return
    fi
  done <<< "$rows"

  [[ -n "$found" ]] || return 1
  [[ "$ambiguous" -eq 0 ]] || return 3
  printf '%s' "$found"
}

tmux_client_rows() {
  tmux_command list-clients -F '#{client_tty}|#{client_pid}|#{session_id}|#{pane_id}|#{window_id}|#{pid}|#{client_control_mode}'
}

tmux_terminal_client() {
  [[ "$1" == /dev/* && "$2" =~ ^[1-9][0-9]*$ && "$3" != 1 ]]
}

tmux_choose_client() {
  # Capture mode considers only clients viewing the source pane. At click time prefer the
  # captured tty/PID, then a client in the target session, then a sole remaining terminal.
  # 1 = no safe client, 2 = query failure, 3 = replaced server.
  local mode="$1" target_session="$2" target_pane="$3" want_server="$4" want_tty="${5:-}" want_pid="${6:-}"
  local rows tty pid session pane window server control rank count=0 best_tty="" best_pid=0 best_rank=4
  rows="$(tmux_client_rows)" || return 2
  while IFS='|' read -r tty pid session pane window server control; do
    [[ -z "$want_server" || -z "$server" || "$server" == "$want_server" ]] || return 3
    tmux_terminal_client "$tty" "$pid" "$control" || continue
    count=$((count + 1))
    if [[ "$mode" == "capture" ]]; then
      [[ "$session" == "$target_session" && "$pane" == "$target_pane" ]] || continue
      rank=0
    elif [[ "$tty" == "$want_tty" ]]; then
      # A reused tty is not the original client and must not be picked as a fallback.
      [[ -z "$want_pid" || "$pid" == "$want_pid" ]] || continue
      rank=0
    elif [[ "$session" == "$target_session" && "$pane" == "$target_pane" ]]; then
      rank=1
    elif [[ "$session" == "$target_session" ]]; then
      rank=2
    else
      rank=3
    fi
    if [[ "$rank" -lt "$best_rank" || ( "$rank" -eq "$best_rank" && "$pid" -lt "$best_pid" ) ]]; then
      best_rank="$rank" best_pid="$pid" best_tty="$tty"
    fi
  done <<< "$rows"
  [[ -n "$best_tty" && ( "$best_rank" -lt 3 || "$count" -eq 1 ) ]] || return 1
  printf '%s|%s' "$best_tty" "$best_pid"
}

tmux_read_client() {
  # Set the caller's current_session/current_window/current_pane for that exact client.
  # Unlike initial client selection, this recheck cannot pick a fallback.
  local want_tty="$1" want_pid="$2" want_server="$3" rows tty pid session pane window server control
  rows="$(tmux_client_rows)" || return 2
  while IFS='|' read -r tty pid session pane window server control; do
    [[ -z "$want_server" || -z "$server" || "$server" == "$want_server" ]] || return 3
    if [[ "$tty" == "$want_tty" && "$pid" == "$want_pid" ]] && tmux_terminal_client "$tty" "$pid" "$control"; then
      current_session="$session" current_window="$window" current_pane="$pane"
      return 0
    fi
  done <<< "$rows"
  return 1
}

tmux_require_client() {
  local rc=0
  tmux_read_client "$@" || rc=$?
  case "$rc" in
    0) return 0 ;;
    2) notify_error "tmux jump failed: tmux client query failed" ;;
    3) notify_error "tmux jump failed: tmux server changed since the notification" ;;
    *) notify_error "tmux jump failed: the selected client disappeared" ;;
  esac
  return 1
}

tmux_navigate_client() {
  local tty="$1" pid="$2" server="$3" session="$4" window="$5" pane="$6"
  local current_session current_window current_pane
  tmux_require_client "$tty" "$pid" "$server" || return 1

  if [[ "$current_session" != "$session" ]]; then
    if ! tmux_command switch-client -c "$tty" -t "$session"; then
      notify_error "tmux jump failed: tmux switch-client failed"
      return 1
    fi
    tmux_require_client "$tty" "$pid" "$server" || return 1
    if [[ "$current_session" != "$session" ]]; then
      notify_error "tmux jump failed: the client did not switch to the target session"
      return 1
    fi
  fi

  if [[ "$current_window" != "$window" ]]; then
    if ! tmux_command select-window -t "$session:$window"; then
      notify_error "tmux jump failed: tmux select-window failed"
      return 1
    fi
    tmux_require_client "$tty" "$pid" "$server" || return 1
    if [[ "$current_session" != "$session" || "$current_window" != "$window" ]]; then
      notify_error "tmux jump failed: the client does not display the target window"
      return 1
    fi
  fi

  if [[ "$current_pane" != "$pane" ]]; then
    if ! tmux_command select-pane -t "$session:$window.$pane"; then
      notify_error "tmux jump failed: tmux select-pane failed"
      return 1
    fi
    tmux_require_client "$tty" "$pid" "$server" || return 1
  fi

  if [[ "$current_session" != "$session" || "$current_window" != "$window" || "$current_pane" != "$pane" ]]; then
    notify_error "tmux jump failed: the client does not display the target pane"
    return 1
  fi
}

jump_tmux_target() {
  local target="$1" origin_tty="$2" context="$3" TMUX_JUMP_SOCKET=""
  local server="" origin_pid="" actual_server location session window pane client rc=0
  if ! command -v tmux >/dev/null 2>&1; then
    notify_error "tmux jump failed: tmux is not available"
    return 1
  fi
  if [[ -z "$context" ]]; then
    # Only pre-upgrade, name-based callbacks lack a server identity. Pane IDs alone
    # could resolve to an unrelated pane on another tmux server.
    if [[ ! "$target" =~ ^[^:]+:[0-9]+\.[0-9]+$ ]]; then
      notify_error "tmux jump failed: missing captured server context"
      return 1
    fi
  else
    IFS='|' read -r server origin_pid TMUX_JUMP_SOCKET <<< "$context"
    if [[ ! "$server" =~ ^[1-9][0-9]*$ || "$TMUX_JUMP_SOCKET" != /* || ( -n "$origin_pid" && ! "$origin_pid" =~ ^[1-9][0-9]*$ ) ]]; then
      notify_error "tmux jump failed: invalid captured client/server context"
      return 1
    fi
    if ! actual_server="$(tmux_command display-message -p '#{pid}')"; then
      notify_error "tmux jump failed: tmux server query failed"
      return 1
    fi
    if [[ "$actual_server" != "$server" ]]; then
      notify_error "tmux jump failed: tmux server changed since the notification"
      return 1
    fi
  fi

  location="$(tmux_resolve_target "$target")" || rc=$?
  case "$rc" in
    0) ;;
    2) notify_error "tmux jump failed: tmux pane query failed"; return 1 ;;
    3) notify_error "tmux jump failed: target pane is linked to multiple sessions"; return 1 ;;
    *) notify_error "tmux jump failed: target pane no longer exists (${target})"; return 1 ;;
  esac
  IFS='|' read -r session window pane <<< "$location"

  client="$(tmux_choose_client jump "$session" "$pane" "$server" "$origin_tty" "$origin_pid")" || rc=$?
  case "$rc" in
    0) tmux_navigate_client "${client%%|*}" "${client#*|}" "$server" "$session" "$window" "$pane" ;;
    2) notify_error "tmux jump failed: tmux client query failed"; return 1 ;;
    3) notify_error "tmux jump failed: tmux server changed since the notification"; return 1 ;;
    *) notify_error "tmux jump failed: no attached tmux client to switch to the target safely"; return 1 ;;
  esac
}

detect_display_backend() {
  # 检测图形后端，便于后续扩展 Wayland 跳转实现
  if [[ "$session_type" == "x11" ]]; then
    printf '%s' "x11"
    return
  fi
  if [[ "$session_type" == "wayland" || -n "${WAYLAND_DISPLAY:-}" ]]; then
    printf '%s' "wayland"
    return
  fi
  if [[ -n "${DISPLAY:-}" ]]; then
    printf '%s' "x11"
    return
  fi
  printf '%s' "none"
}

resolve_x11_window_target() {
  # 优先使用通知源窗口 ID；直接调用脚本时兼容常见终端环境变量。
  local id="${PI_NOTIFY_WINDOW_ID:-${WINDOWID:-${WINDOW_ID:-${alacritty_window_id:-}}}}"
  if [[ -n "$id" ]]; then
    printf '%s' "$id"
    return
  fi

  if command -v tmux >/dev/null 2>&1 && [[ -n "${TMUX:-}" ]]; then
    local tmux_window_id
    tmux_window_id="$(tmux show-environment WINDOWID 2>/dev/null || true)"
    if [[ "$tmux_window_id" == WINDOWID=* ]]; then
      id="${tmux_window_id#WINDOWID=}"
    fi
  fi

  printf '%s' "$id"
}

is_gnome_desktop() {
  # 仅 GNOME Wayland 使用按窗口标题定位的扩展接口。
  local desktop="${current_desktop:-$desktop_session}"
  desktop="${desktop,,}"
  [[ "$desktop" == *gnome* ]]
}

is_gnome_wayland() {
  [[ "$session_type" == "wayland" || ( -z "$session_type" && -n "${WAYLAND_DISPLAY:-}" ) ]] && is_gnome_desktop
}

gnome_client_candidates() {
  # Freeze source-pane viewers first, then other clients in its session. A client in a
  # different session is a fallback only if there is exactly one such candidate.
  local rows tty pid session pane window server control priority collected="" fallback="" others=0
  rows="$(tmux_client_rows)" || return 1
  while IFS='|' read -r tty pid session pane window server control; do
    [[ -z "$server" || "$server" == "$GNOME_SERVER_PID" ]] || return 1
    tmux_terminal_client "$tty" "$pid" "$control" || continue
    if [[ "$pane" == "$GNOME_PANE" ]]; then
      priority=0
    elif [[ "$session" == "$GNOME_SESSION" ]]; then
      priority=1
    else
      others=$((others + 1))
      fallback="2|${pid}|${tty}"$'\n'
      continue
    fi
    collected+="${priority}|${pid}|${tty}"$'\n'
  done <<< "$rows"
  if [[ "$others" -eq 1 ]]; then
    collected+="$fallback"
  fi
  [[ -n "$collected" ]] || return 0
  printf '%s' "$collected" | sort -t'|' -k1,1n -k2,2n | while IFS='|' read -r _ pid tty; do
    printf '%s|%s\n' "$tty" "$pid"
  done
}

resolve_gnome_context() {
  # Capture identities without activating a window or switching a client.
  local location
  command -v tmux >/dev/null 2>&1 || return 1
  [[ "$tmux_pane" =~ ^%[0-9]+$ ]] || return 1
  GNOME_PANE="$tmux_pane"
  GNOME_SERVER_PID="$(tmux_command display-message -p '#{pid}')" || return 1
  [[ "$GNOME_SERVER_PID" =~ ^[1-9][0-9]*$ ]] || return 1
  location="$(tmux_resolve_target "$GNOME_PANE")" || return 1
  GNOME_SESSION="${location%%|*}"
  GNOME_CANDIDATES="$(gnome_client_candidates)" || return 1
  [[ -n "$GNOME_CANDIDATES" ]]
}

gnome_revalidate_source() {
  # The pane must still be unique in the captured session. It can move to another window.
  local server location session pane rc=0
  if ! server="$(tmux_command display-message -p '#{pid}')"; then
    notify_error "GNOME focus aborted: tmux server query failed"
    return 1
  fi
  if [[ "$server" != "$GNOME_SERVER_PID" ]]; then
    notify_error "GNOME focus aborted: tmux server changed since the notification"
    return 1
  fi
  location="$(tmux_resolve_target "$GNOME_PANE")" || rc=$?
  if [[ "$rc" -eq 2 ]]; then
    notify_error "GNOME focus aborted: tmux pane query failed"
    return 1
  fi
  IFS='|' read -r session GNOME_CLICK_WINDOW pane <<< "$location"
  if [[ "$rc" -ne 0 || "$session" != "$GNOME_SESSION" ]]; then
    notify_error "GNOME focus aborted: source pane/session changed since the notification"
    return 1
  fi
}

gnome_activate_suffix() {
  # Request exact-title activation through the extension and report its reply:
  # 0 = the extension matched a local window carrying this exact title and was asked to
  #     activate it (a request, never observed focus),
  # 1 = no local window carries the title ((false,), e.g. an SSH client),
  # 2 = D-Bus/extension error or unexpected reply; GNOME_DBUS_ERROR holds the detail.
  local suffix="$1" output rc
  GNOME_DBUS_ERROR=""
  if ! command -v gdbus >/dev/null 2>&1; then
    GNOME_DBUS_ERROR="gdbus is not available"
    return 2
  fi
  if output="$(gdbus call --session --timeout 2 \
    --dest org.gnome.Shell \
    --object-path /de/lucaswerkmeister/ActivateWindowByTitle \
    --method de.lucaswerkmeister.ActivateWindowByTitle.activateBySuffix \
    -- "$suffix" 2>&1)"; then
    rc=0
  else
    rc=$?
  fi
  if [[ "$rc" -ne 0 ]]; then
    GNOME_DBUS_ERROR="gdbus exit ${rc}: ${output//$'\n'/ }"
    return 2
  fi
  case "$output" in
    "(true,)") return 0 ;;
    "(false,)") return 1 ;;
    *) GNOME_DBUS_ERROR="unexpected reply: ${output}"; return 2 ;;
  esac
}

gnome_choose_candidate() {
  # Walk the frozen candidates in priority order. Every candidate is re-validated just
  # before its activation: a vanished client is skipped (and never retried), while a
  # changed server/source or a query/D-Bus error aborts the whole click. Sets
  # GNOME_CHOSEN="tty|pid" and returns 0 on the first exact title that the extension
  # matches; otherwise reports the stage and returns 1.
  GNOME_CHOSEN=""
  local pass tty pid rc suffix probed=0 current_session current_window current_pane
  for pass in 1 2 3; do
    while IFS='|' read -r tty pid; do
      [[ -n "$tty" ]] || continue
      gnome_revalidate_source || return 1
      rc=0
      tmux_read_client "$tty" "$pid" "$GNOME_SERVER_PID" || rc=$?
      case "$rc" in
        0) ;;
        1) continue ;; # The captured client vanished; try the next one.
        2) notify_error "GNOME focus aborted: tmux client query failed"; return 1 ;;
        3) notify_error "GNOME focus aborted: tmux server changed since the notification"; return 1 ;;
      esac
      ((probed += 1))
      suffix="[pi-tmux:${GNOME_SERVER_PID}:${pid}]"
      if gnome_activate_suffix "$suffix"; then
        GNOME_CHOSEN="$tty|$pid"
        return 0
      else
        rc=$?
      fi
      if [[ "$rc" -eq 2 ]]; then
        notify_error "GNOME focus aborted: D-Bus activation error: ${GNOME_DBUS_ERROR}"
        return 1
      fi
    done <<< "$GNOME_CANDIDATES"
    # Bounded retry so a title that propagates slightly late is still picked up.
    [[ "$pass" -eq 3 ]] || sleep 0.15
  done
  if [[ "$probed" -eq 0 ]]; then
    notify_error "GNOME focus aborted: all captured tmux clients disappeared before activation"
  else
    notify_error "GNOME focus failed: no local window matched any captured tmux client title"
  fi
  return 1
}

perform_gnome_jump() {
  # Click path. No tmux side effect happens until the extension matches a local window for
  # one candidate, and only that frozen candidate is switched; unmatched clients are
  # untouched. A successful reply is a requested activation, not observed focus.
  local tty pid suffix attempt rc current_session current_window current_pane
  gnome_choose_candidate || return 1
  IFS='|' read -r tty pid <<< "$GNOME_CHOSEN"

  # The source may have changed during the title activation request.
  gnome_revalidate_source || return 1
  tmux_navigate_client "$tty" "$pid" "$GNOME_SERVER_PID" "$GNOME_SESSION" "$GNOME_CLICK_WINDOW" "$GNOME_PANE" || return 1

  # The second request follows any tmux title update; a match is not proof of focus.
  suffix="[pi-tmux:${GNOME_SERVER_PID}:${pid}]"
  for attempt in 1 2 3; do
    gnome_revalidate_source || return 1
    tmux_require_client "$tty" "$pid" "$GNOME_SERVER_PID" || return 1
    if [[ "$current_session" != "$GNOME_SESSION" || "$current_window" != "$GNOME_CLICK_WINDOW" || "$current_pane" != "$GNOME_PANE" ]]; then
      notify_error "GNOME focus aborted: the client no longer displays the source pane"
      return 1
    fi
    if gnome_activate_suffix "$suffix"; then
      return 0
    else
      rc=$?
    fi
    if [[ "$rc" -eq 2 ]]; then
      notify_error "GNOME focus aborted: D-Bus activation error: ${GNOME_DBUS_ERROR}"
      return 1
    fi
    [[ "$attempt" -eq 3 ]] || sleep 0.15
  done
  notify_error "GNOME focus failed: the selected window stopped matching its title"
  return 1
}

send_plain_notification() {
  local icon="$1" title="$2" body="$3"
  notify-send -i "$icon" -t 10000 -- "$title" "$body"
}

send_gnome_notification() {
  local icon="$1" title="$2" body="$3" rc=0
  if ! resolve_gnome_context; then
    notify_error "no GNOME tmux focus target; sending a plain notification"
    send_plain_notification "$icon" "$title" "$body"
    return
  fi
  if ! command -v python3 >/dev/null 2>&1 || [[ ! -f "$ACTION_NOTIFY_SCRIPT" ]]; then
    notify_error "GNOME notification actions require python3 and notify-action.py; sending a plain notification"
    send_plain_notification "$icon" "$title" "$body"
    return
  fi
  # The helper must keep the sending D-Bus connection open to receive GNOME's click.
  python3 "$ACTION_NOTIFY_SCRIPT" "$icon" "$title" "$body" "${PI_NOTIFY_ACTION_TIMEOUT_SEC:-600}" || rc=$?
  case "$rc" in
    0) perform_gnome_jump ;;
    2) send_plain_notification "$icon" "$title" "$body" ;;
    3) return 0 ;; # The notification was closed or the action timed out.
    *) notify_error "GNOME notification action helper exited with status $rc"; return "$rc" ;;
  esac
}

jump_x11_window() {
  # X11 跳转优先使用 dwm fake signal；失败再回退通用工具
  local window_id="$1"
  local ok=1
  if [[ -z "$window_id" ]]; then
    return 1
  fi

  if command -v xsetroot >/dev/null 2>&1; then
    if xsetroot -name "fsignal:switchtoclientwin ul ${window_id}" >/dev/null 2>&1; then
      ok=0
    fi
  fi

  if command -v xdotool >/dev/null 2>&1; then
    if xdotool windowactivate "$window_id" >/dev/null 2>&1; then
      return 0
    fi
  fi

  if command -v wmctrl >/dev/null 2>&1; then
    local hex_id
    hex_id="$(printf '0x%08x' "$window_id" 2>/dev/null || true)"
    if [[ -n "$hex_id" ]]; then
      if wmctrl -i -a "$hex_id" >/dev/null 2>&1; then
        return 0
      fi
    fi
  fi

  return "$ok"
}

# ------------------------- Jump: Action Dispatch -------------------------

perform_jump_action() {
  local tmux_target="$1" tmux_client_tty="$2" tmux_context="$3" backend="$4" x11_window_id="$5" rc=0
  if [[ -n "$tmux_target" ]]; then
    jump_tmux_target "$tmux_target" "$tmux_client_tty" "$tmux_context" || rc=1
  fi
  if [[ "$backend" == "x11" && -n "$x11_window_id" ]] && ! jump_x11_window "$x11_window_id"; then
    notify_error "X11 jump failed: could not activate window ${x11_window_id}"
    rc=1
  fi
  return "$rc"
}

resolve_jump_context() {
  local identity server socket location session window pane client="" rc=0
  JUMP_BACKEND="$(detect_display_backend)"
  JUMP_X11_WINDOW_ID="$(resolve_x11_window_target)"
  JUMP_TMUX_TARGET="" JUMP_TMUX_CLIENT_TTY="" JUMP_TMUX_CONTEXT=""

  [[ "$tmux_pane" =~ ^%[0-9]+$ ]] && command -v tmux >/dev/null 2>&1 || return 0
  identity="$(tmux_command display-message -p '#{pid}|#{socket_path}' 2>/dev/null)" || return 0
  IFS='|' read -r server socket <<< "$identity"
  [[ "$server" =~ ^[1-9][0-9]*$ && "$socket" == /* ]] || return 0
  local TMUX_JUMP_SOCKET="$socket"
  location="$(tmux_resolve_target "$tmux_pane" 2>/dev/null)" || return 0
  IFS='|' read -r session window pane <<< "$location"
  client="$(tmux_choose_client capture "$session" "$pane" "$server" 2>/dev/null)" || rc=$?
  [[ "$rc" -le 1 ]] || return 0

  JUMP_TMUX_TARGET="$session:$window.$pane"
  JUMP_TMUX_CLIENT_TTY="${client%%|*}"
  # The WSL worker carries this as base64. Keep the socket last so it can contain delimiters.
  JUMP_TMUX_CONTEXT="$server|${client#*|}|$socket"
}

# ------------------------- Audio -------------------------

play_with_backend() {
  # 播放器适配层：后续扩展其他系统时只需在这里新增分支
  local backend="$1"
  local file="$2"

  case "$backend" in
    paplay)
      if command -v paplay >/dev/null 2>&1; then
        # Pulse/PipeWire 在 HDMI idle 唤醒时可能吞掉首段音频；先唤醒 sink 再播放。
        if command -v pactl >/dev/null 2>&1; then
          pactl suspend-sink @DEFAULT_SINK@ 0 >/dev/null 2>&1 || true
          sleep "$PULSE_WAKEUP_SLEEP_SEC"
        fi
        # 不显式指定 --volume，使用系统当前默认音量与路由策略。
        paplay --stream-name="pi-notify" "$file" >/dev/null 2>&1
        return 0
      fi
      ;;
    aplay)
      if command -v aplay >/dev/null 2>&1; then
        aplay "$file" >/dev/null 2>&1
        return 0
      fi
      ;;
    ffplay)
      if command -v ffplay >/dev/null 2>&1; then
        ffplay -nodisp -autoexit -loglevel quiet "$file" >/dev/null 2>&1
        return 0
      fi
      ;;
  esac

  return 1
}

# ------------------------- Notification -------------------------

send_linux_notification() {
  # Linux 通知分两类：
  # - GNOME/Wayland：按候选优先级匹配本地窗口，再切换 tmux 目标
  # - 其他环境：带 Jump/Cancel 动作的通用跳转
  local icon="$1"
  local title="$2"
  local body="$3"
  local action

  if is_gnome_wayland; then
    send_gnome_notification "$icon" "$title" "$body"
    return
  fi

  resolve_jump_context
  if [[ -z "$JUMP_TMUX_TARGET" && ( "$JUMP_BACKEND" != "x11" || -z "$JUMP_X11_WINDOW_ID" ) ]]; then
    send_plain_notification "$icon" "$title" "$body"
    return
  fi
  action="$(notify-send -i "$icon" -t 10000 -A 'jump=Jump' -A 'cancel=Cancel' -- "$title" "$body")" || return 1
  if [[ "$action" == "jump" ]]; then
    perform_jump_action "$JUMP_TMUX_TARGET" "$JUMP_TMUX_CLIENT_TTY" "$JUMP_TMUX_CONTEXT" "$JUMP_BACKEND" "$JUMP_X11_WINDOW_ID"
  fi
}

validate_linux_assets() {
  # Linux 通知依赖本地图标；资源缺失时直接退出
  if [[ ! -f "$ICON_FILE" ]]; then
    exit 0
  fi
}

run_linux_notification() {
  # Linux 分支：保持既有通知、声音与 Jump 行为
  local title

  validate_linux_assets
  title="$(build_title)"
  build_message

  # 通知动作会等待用户选择，因此先播放声音。
  play_linux_sound "$SOUND_FILE" || true
  send_linux_notification "$ICON_FILE" "$title" "$message"
}

run_windows_notification() {
  # Windows 分支：依赖系统通知音，不额外播放本地 wav
  local title

  title="$(build_title)"
  build_message
  resolve_jump_context
  send_windows_notification "$ICON_FILE" "$title" "$message" "$JUMP_TMUX_TARGET" "$JUMP_TMUX_CLIENT_TTY" "$JUMP_TMUX_CONTEXT"
}

run_jump_command() {
  # The Windows callback skips notification creation and may carry a pre-upgrade target.
  local target="${PI_NOTIFY_TMUX_TARGET:-}" context=""
  [[ -n "$target" ]] || return 0
  if [[ -n "${PI_NOTIFY_TMUX_CONTEXT_BASE64:-}" ]]; then
    if ! context="$(printf '%s' "$PI_NOTIFY_TMUX_CONTEXT_BASE64" | base64 -d)" || [[ -z "$context" ]]; then
      notify_error "tmux jump failed: invalid encoded client/server context"
      return 1
    fi
  fi
  jump_tmux_target "$target" "${PI_NOTIFY_TMUX_CLIENT_TTY:-}" "$context"
}

main() {
  # 主流程：支持通知发送与回调跳转两类入口
  local mode="${1:-notify}"

  if [[ "$mode" == "jump" ]]; then
    run_jump_command
    return
  fi

  # 主流程：按平台后端分支执行，避免不同系统逻辑互相耦合
  local backend

  backend="$(detect_notify_backend)"
  case "$backend" in
    linux)
      run_linux_notification
      ;;
    windows)
      run_windows_notification
      ;;
    *)
      exit 0
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
