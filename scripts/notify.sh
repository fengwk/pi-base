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

# ------------------------- Jump: Target Resolution -------------------------

resolve_tmux_target() {
  # 解析当前通知来源对应的 tmux 目标（session:window.pane）
  local target=""

  if ! command -v tmux >/dev/null 2>&1; then
    printf '%s' ""
    return
  fi

  if [[ -n "$tmux_pane" ]]; then
    while IFS=' ' read -r pane pane_target; do
      if [[ "$pane" == "$tmux_pane" ]]; then
        target="$pane_target"
        break
      fi
    done < <(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || true)
  fi

  if [[ -z "$target" && -n "${TMUX:-}" ]]; then
    target="$(tmux display-message -p '#S:#I.#P' 2>/dev/null || true)"
  fi

  printf '%s' "$target"
}

jump_tmux_target() {
  # 仅实现 tmux 跳转：切会话 -> 切窗口 -> 切 pane
  local target="$1"
  local client_tty="$2"
  local session=""
  local window=""

  if [[ -z "$target" ]]; then
    return 1
  fi

  session="${target%%:*}"
  window="${target#*:}"
  window="${window%%.*}"

  if [[ -n "$client_tty" ]]; then
    tmux switch-client -c "$client_tty" -t "$session" >/dev/null 2>&1 || true
  else
    tmux switch-client -t "$session" >/dev/null 2>&1 || true
  fi

  tmux select-window -t "${session}:${window}" >/dev/null 2>&1 || true

  # 以最终 pane 选中是否成功作为跳转成功标准。
  if tmux select-pane -t "$target" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

resolve_tmux_client_tty() {
  # 记录通知产生时所在 tmux client tty，用于后续精准跳转。
  # 优先按 pane 目标反查可见 client，避免 detached 脚本里丢失“当前 client”上下文。
  local target="$1"
  local tty=""

  if command -v tmux >/dev/null 2>&1; then
    if [[ -n "$target" ]]; then
      while IFS=' ' read -r client_tty client_target; do
        if [[ "$client_target" == "$target" ]]; then
          tty="$client_tty"
          break
        fi
      done < <(tmux list-clients -F '#{client_tty} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || true)
    fi

    if [[ -z "$tty" && -n "${TMUX:-}" ]]; then
      tty="$(tmux display-message -p '#{client_tty}' 2>/dev/null || true)"
    fi
  fi

  printf '%s' "$tty"
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

gnome_resolve_pane() {
  # Resolve the captured source pane to exactly one session/window. list-panes -a lists a
  # linked window once per session, so more than one row means an ambiguous target.
  # Returns 2 when the tmux query itself fails, 1 when the pane is not uniquely present.
  local rows pane session window
  local count=0
  GNOME_PANE_SESSION="" GNOME_PANE_WINDOW=""
  rows="$(tmux list-panes -a -F '#{pane_id}|#{session_id}|#{window_id}')" || return 2
  while IFS='|' read -r pane session window; do
    if [[ "$pane" == "$GNOME_PANE" ]]; then
      GNOME_PANE_SESSION="$session"
      GNOME_PANE_WINDOW="$window"
      ((count += 1))
    fi
  done <<< "$rows"
  [[ "$count" -eq 1 && "$GNOME_PANE_SESSION" == \$* && "$GNOME_PANE_WINDOW" == @* ]]
}

gnome_client_candidates() {
  # Ordered click candidates as "tty|pid": clients currently viewing the source pane,
  # then clients of the source session, then any other client on the same server. Numeric
  # PID ascending breaks ties so enumeration order never changes the outcome. Malformed
  # rows are rejected so a bogus tty/PID is never switched or activated.
  local rows tty pid session pane priority
  local collected=""
  rows="$(tmux list-clients -F '#{client_tty}|#{client_pid}|#{session_id}|#{pane_id}')" || return 1
  while IFS='|' read -r tty pid session pane; do
    [[ "$tty" == /dev/* && "$pid" =~ ^[0-9]+$ ]] || continue
    if [[ "$pane" == "$GNOME_PANE" ]]; then
      priority=0
    elif [[ "$session" == "$GNOME_SESSION" ]]; then
      priority=1
    else
      priority=2
    fi
    collected+="${priority}|${pid}|${tty}"$'\n'
  done <<< "$rows"
  [[ -n "$collected" ]] || return 0
  while IFS='|' read -r _ pid tty; do
    printf '%s|%s\n' "$tty" "$pid"
  done < <(printf '%s' "$collected" | sort -t'|' -k1,1n -k2,2n)
}

resolve_gnome_context() {
  # Creation-time snapshot only: server identity, source pane/session and the frozen,
  # ordered client candidate list. Nothing is activated and no client is switched here.
  GNOME_PANE="" GNOME_PANE_SESSION="" GNOME_PANE_WINDOW="" GNOME_SESSION="" GNOME_SERVER_PID="" GNOME_CANDIDATES=""
  command -v tmux >/dev/null 2>&1 || return 1
  [[ "$tmux_pane" == %* ]] || return 1
  GNOME_PANE="$tmux_pane"
  gnome_resolve_pane || return 1
  GNOME_SESSION="$GNOME_PANE_SESSION"
  GNOME_SERVER_PID="$(tmux display-message -p '#{pid}')" || return 1
  [[ "$GNOME_SERVER_PID" =~ ^[0-9]+$ ]] || return 1
  GNOME_CANDIDATES="$(gnome_client_candidates)" || return 1
  # Without any attached client there is nothing to switch to, so offer no action.
  [[ -n "$GNOME_CANDIDATES" ]]
}

gnome_fail() {
  # Emit one stage-specific diagnostic. Callers that already reported a stage must not be
  # summarized by the notification wrapper as "no local window matched".
  GNOME_DIAGNOSTIC=1
  printf 'Pi notify: %s\n' "$1" >&2
}

gnome_revalidate_source() {
  # 0 only while the captured server runs and the captured pane is still uniquely part of
  # the captured session. GNOME_CLICK_WINDOW carries the current window ID so the tmux
  # switch never targets a stale window. Failure records the stale stage on stderr.
  local server resolved=0
  GNOME_CLICK_WINDOW=""
  if ! server="$(tmux display-message -p '#{pid}' 2>/dev/null)"; then
    gnome_fail "GNOME focus aborted: tmux server query failed"
    return 1
  fi
  if [[ -z "$GNOME_SERVER_PID" || "$server" != "$GNOME_SERVER_PID" ]]; then
    gnome_fail "GNOME focus aborted: tmux server changed since the notification"
    return 1
  fi
  gnome_resolve_pane || resolved=$?
  if [[ "$resolved" -eq 2 ]]; then
    gnome_fail "GNOME focus aborted: tmux pane query failed"
    return 1
  fi
  if [[ "$resolved" -ne 0 || "$GNOME_PANE_SESSION" != "$GNOME_SESSION" ]]; then
    gnome_fail "GNOME focus aborted: source pane/session changed since the notification"
    return 1
  fi
  GNOME_CLICK_WINDOW="$GNOME_PANE_WINDOW"
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

gnome_client_still_current() {
  # The caller validates the server. Return 2 for query failure, 1 for a missing client.
  local want_tty="$1" want_pid="$2" rows tty pid
  rows="$(tmux list-clients -F '#{client_tty}|#{client_pid}' 2>/dev/null)" || return 2
  while IFS='|' read -r tty pid; do
    if [[ "$tty" == "$want_tty" && "$pid" == "$want_pid" ]]; then
      return 0
    fi
  done <<< "$rows"
  return 1
}

gnome_choose_candidate() {
  # Walk the frozen candidates in priority order. Every candidate is re-validated just
  # before its activation: a vanished client is skipped (and never retried), while a
  # changed server/source or a query/D-Bus error aborts the whole click. Sets
  # GNOME_CHOSEN="tty|pid" and returns 0 on the first exact title that the extension
  # matches; otherwise reports the stage and returns 1.
  GNOME_CHOSEN=""
  local pass tty pid rc suffix probed=0
  for pass in 1 2 3; do
    while IFS='|' read -r tty pid; do
      [[ -n "$tty" ]] || continue
      # The source/server must still be valid before touching the next candidate.
      gnome_revalidate_source || return 1
      # A candidate that disappeared is skipped, not activated against a stale identity.
      if gnome_client_still_current "$tty" "$pid"; then
        :
      else
        rc=$?
        if [[ "$rc" -eq 2 ]]; then
          gnome_fail "GNOME focus aborted: tmux client query failed"
          return 1
        fi
        continue
      fi
      ((probed += 1))
      suffix="[pi-tmux:${GNOME_SERVER_PID}:${pid}]"
      if gnome_activate_suffix "$suffix"; then
        GNOME_CHOSEN="$tty|$pid"
        return 0
      else
        rc=$?
      fi
      if [[ "$rc" -eq 2 ]]; then
        gnome_fail "GNOME focus aborted: D-Bus activation error: ${GNOME_DBUS_ERROR}"
        return 1
      fi
    done <<< "$GNOME_CANDIDATES"
    # Bounded retry so a title that propagates slightly late is still picked up.
    [[ "$pass" -eq 3 ]] || sleep 0.15
  done
  if [[ "$probed" -eq 0 ]]; then
    gnome_fail "GNOME focus aborted: all captured tmux clients disappeared before activation"
  else
    gnome_fail "GNOME focus failed: no local window matched any captured tmux client title"
  fi
  return 1
}

perform_gnome_jump() {
  # Click path. No tmux side effect happens until the extension matches a local window for
  # one candidate, and only that frozen candidate is switched; unmatched clients are
  # untouched. A successful reply is a requested activation, not observed focus.
  local tty pid suffix attempt rc
  GNOME_DIAGNOSTIC=0 GNOME_CHOSEN=""
  gnome_revalidate_source || return 1
  gnome_choose_candidate || return 1
  tty="${GNOME_CHOSEN%%|*}"
  pid="${GNOME_CHOSEN##*|}"
  if [[ "$tty" != /dev/* || ! "$pid" =~ ^[0-9]+$ ]]; then
    gnome_fail "GNOME focus aborted: invalid selected client"
    return 1
  fi

  # Re-check the source and the chosen client after the activation round trip.
  gnome_revalidate_source || return 1
  if ! gnome_client_still_current "$tty" "$pid"; then
    gnome_fail "GNOME focus aborted: selected client disappeared before switching"
    return 1
  fi

  if ! tmux switch-client -c "$tty" -t "$GNOME_SESSION"; then
    gnome_fail "GNOME focus failed: tmux switch-client failed"
    return 1
  fi
  if ! tmux select-window -t "${GNOME_SESSION}:${GNOME_CLICK_WINDOW}"; then
    gnome_fail "GNOME focus failed: tmux select-window failed"
    return 1
  fi
  if ! tmux select-pane -t "${GNOME_SESSION}:${GNOME_CLICK_WINDOW}.${GNOME_PANE}"; then
    gnome_fail "GNOME focus failed: tmux select-pane failed"
    return 1
  fi

  # Ask the extension to activate the window again after the tmux switch. The reply only
  # confirms a matching window was asked to activate; it is not observed focus.
  suffix="[pi-tmux:${GNOME_SERVER_PID}:${pid}]"
  for attempt in 1 2 3; do
    gnome_revalidate_source || return 1
    if ! gnome_client_still_current "$tty" "$pid"; then
      gnome_fail "GNOME focus aborted: selected client disappeared before activation"
      return 1
    fi
    if gnome_activate_suffix "$suffix"; then
      return 0
    else
      rc=$?
    fi
    if [[ "$rc" -eq 2 ]]; then
      gnome_fail "GNOME focus aborted: D-Bus activation error: ${GNOME_DBUS_ERROR}"
      return 1
    fi
    [[ "$attempt" -eq 3 ]] || sleep 0.15
  done
  gnome_fail "GNOME focus failed: the selected window stopped matching its title"
  return 1
}

send_gnome_notification() {
  local icon="$1" title="$2" body="$3" action=""
  if ! resolve_gnome_context; then
    printf '%s\n' 'Pi notify: no GNOME tmux focus target; notification has no focus action' >&2
    notify-send -i "$icon" -t 10000 "$title" "$body"
    return
  fi
  # A local window cannot be proven before the click, so an SSH-only server may offer an
  # action that fails at click time; that failure is reported instead of a false success.
  action="$(notify-send -i "$icon" -t 10000 -A "default=切回并聚焦" "$title" "$body")" || return 1
  if [[ "$action" == "default" ]]; then
    if ! perform_gnome_jump; then
      # The failing stage is already on stderr; never restate every error as a title miss.
      if [[ "${GNOME_DIAGNOSTIC:-0}" -eq 0 ]]; then
        printf '%s\n' 'Pi notify: GNOME focus failed' >&2
      fi
      return 1
    fi
  fi
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
  # Legacy Windows/X11 jump; GNOME uses its own strict target path.
  local tmux_target="$1"
  local tmux_client_tty="$2"
  local backend="$3"
  local x11_window_id="$4"
  local jumped=1

  if [[ -n "$tmux_target" ]] && command -v tmux >/dev/null 2>&1; then
    if jump_tmux_target "$tmux_target" "$tmux_client_tty"; then
      jumped=0
    fi
  fi

  if [[ "$backend" == "x11" ]]; then
    if jump_x11_window "$x11_window_id"; then
      jumped=0
    fi
  fi

  return "$jumped"
}

resolve_jump_context() {
  # 统一收集 Jump 所需上下文
  JUMP_TMUX_TARGET="$(resolve_tmux_target)"
  JUMP_TMUX_CLIENT_TTY="$(resolve_tmux_client_tty "$JUMP_TMUX_TARGET")"
  JUMP_BACKEND="$(detect_display_backend)"
  JUMP_X11_WINDOW_ID="$(resolve_x11_window_target)"
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
  # - 其他环境：保留带动作按钮的 Jump 交互
  local icon="$1"
  local title="$2"
  local body="$3"
  local action=""

  if command -v notify-send >/dev/null 2>&1; then
    if is_gnome_wayland; then
      send_gnome_notification "$icon" "$title" "$body"
      return
    fi
    resolve_jump_context

    action="$(notify-send -i "$icon" -t 10000 -A "jump=Jump" -A "cancel=Cancel" "$title" "$body" 2>/dev/null || true)"
    if [[ "$action" == "jump" ]]; then
      perform_jump_action "$JUMP_TMUX_TARGET" "$JUMP_TMUX_CLIENT_TTY" "$JUMP_BACKEND" "$JUMP_X11_WINDOW_ID"
    fi
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

  # notify-send 使用动作按钮时会等待用户选择，因此先播放声音
  # 可以确保通知弹出时立即有提示音，而不是点击后才播放。
  play_linux_sound "$SOUND_FILE" || true
  send_linux_notification "$ICON_FILE" "$title" "$message"
}

run_windows_notification() {
  # Windows 分支：依赖系统通知音，不额外播放本地 wav
  local title

  title="$(build_title)"
  build_message
  resolve_jump_context
  send_windows_notification "$ICON_FILE" "$title" "$message" "$JUMP_TMUX_TARGET" "$JUMP_TMUX_CLIENT_TTY" || true
}

run_jump_command() {
  # Windows helper 回调入口：仅执行无感跳转，不重复发送通知
  local tmux_target="${PI_NOTIFY_TMUX_TARGET:-}"
  local tmux_client_tty="${PI_NOTIFY_TMUX_CLIENT_TTY:-}"

  if [[ -z "$tmux_target" ]]; then
    exit 0
  fi

  if perform_jump_action "$tmux_target" "$tmux_client_tty" "none" ""; then
    exit 0
  fi

  exit 1
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
