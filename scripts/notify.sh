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
GNOME_WAYLAND_ATTENTION_SETTLE_SEC="${PI_NOTIFY_GNOME_WAYLAND_ATTENTION_SETTLE_SEC:-0.2}"

kind="${PI_NOTIFY_KIND:-generic}"
project="${PI_NOTIFY_PROJECT:-}"
session_id="${PI_NOTIFY_SESSION_ID:-}"
session_title="${PI_NOTIFY_SESSION_TITLE:-}"
session_type="${PI_NOTIFY_SESSION_TYPE:-${XDG_SESSION_TYPE:-}}"
current_desktop="${PI_NOTIFY_CURRENT_DESKTOP:-${XDG_CURRENT_DESKTOP:-}}"
desktop_session="${PI_NOTIFY_DESKTOP_SESSION:-${DESKTOP_SESSION:-}}"
tmux_pane="${PI_NOTIFY_TMUX_PANE:-${TMUX_PANE:-}}"
alacritty_window_id="${PI_NOTIFY_ALACRITTY_WINDOW_ID:-${ALACRITTY_WINDOW_ID:-}}"
terminal_tty="${PI_NOTIFY_TERMINAL_TTY:-}"
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
  # 优先使用通知源窗口 ID，其次从 tmux pane pid 反查 X11 窗口
  local id="${PI_NOTIFY_WINDOW_ID:-}"
  if [[ -n "$id" ]]; then
    printf '%s' "$id"
    return
  fi

  if command -v tmux >/dev/null 2>&1 && command -v xdotool >/dev/null 2>&1 && [[ -n "${TMUX:-}" ]]; then
    local pane_pid
    pane_pid="$(tmux display-message -p '#{pane_pid}' 2>/dev/null || true)"
    if [[ -n "$pane_pid" ]]; then
      while IFS= read -r wid; do
        if [[ -n "$wid" ]]; then
          id="$wid"
          break
        fi
      done < <(xdotool search --pid "$pane_pid" 2>/dev/null || true)
    fi
  fi

  printf '%s' "$id"
}

is_gnome_desktop() {
  # Wayland + GNOME 走 attention 跳回链路，需要显式识别 GNOME 桌面
  local desktop="${current_desktop:-$desktop_session}"
  desktop="${desktop,,}"
  [[ "$desktop" == *gnome* ]]
}

resolve_tmux_pane_tty() {
  # 解析通知来源 pane 的 tty，供 tmux 切回后触发终端 attention 使用
  local tty=""

  if ! command -v tmux >/dev/null 2>&1; then
    printf '%s' ""
    return
  fi

  if [[ -n "$tmux_pane" ]]; then
    while IFS=' ' read -r pane pane_tty; do
      if [[ "$pane" == "$tmux_pane" ]]; then
        tty="$pane_tty"
        break
      fi
    done < <(tmux list-panes -a -F '#{pane_id} #{pane_tty}' 2>/dev/null || true)
  fi

  if [[ -z "$tty" && -n "${TMUX:-}" ]]; then
    tty="$(tmux display-message -p '#{pane_tty}' 2>/dev/null || true)"
  fi

  printf '%s' "$tty"
}

resolve_attention_tty() {
  # 解析用于发送 urgency 控制序列的 tty。
  # 优先 tmux pane tty；若不在 tmux，则退回插件侧解析到的终端 tty。
  local tty=""

  tty="$(resolve_tmux_pane_tty)"
  if [[ -n "$tty" ]]; then
    printf '%s' "$tty"
    return
  fi

  printf '%s' "$terminal_tty"
}

can_use_gnome_wayland_attention_jump() {
  # GNOME/Wayland 下不能通用地直接抢焦点；改为 tmux 切回 + 终端 attention
  local attention_tty="$1"

  [[ "$session_type" == "wayland" || -n "${WAYLAND_DISPLAY:-}" ]] || return 1
  is_gnome_desktop || return 1
  [[ -n "$alacritty_window_id" ]] || return 1
  [[ -n "$attention_tty" && -w "$attention_tty" ]] || return 1

  return 0
}

request_terminal_attention() {
  # 通过 Alacritty 支持的 urgency 控制序列请求窗口 attention
  local pane_tty="$1"

  if [[ -z "$pane_tty" || ! -w "$pane_tty" ]]; then
    return 1
  fi

  printf '\033[?1042h\a' > "$pane_tty"
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

jump_wayland_window() {
  # 预留 Wayland 跳转入口，后续可按 sway/hypr 增加实现
  :
}

# ------------------------- Jump: Action Dispatch -------------------------

perform_jump_action() {
  # Jump 动作统一入口：tmux + x11（可同时执行） -> wayland
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

  if [[ "$jumped" -ne 0 && "$backend" == "wayland" ]]; then
    jump_wayland_window
  fi

  return "$jumped"
}

perform_gnome_wayland_attention_jump() {
  # GNOME/Wayland 下：点击 Pi 通知后先切 tmux，再请求窗口 attention
  local tmux_target="$1"
  local tmux_client_tty="$2"
  local attention_tty="$3"

  if [[ -n "$tmux_target" ]] && command -v tmux >/dev/null 2>&1; then
    if ! jump_tmux_target "$tmux_target" "$tmux_client_tty"; then
      return 1
    fi
  fi

  # 允许 GNOME/Alacritty 在点击通知后恢复焦点；若目标窗口本就处于前台，
  # 随后的 urgency 请求通常会被忽略，从而避免多余的第二条通知。
  sleep "$GNOME_WAYLAND_ATTENTION_SETTLE_SEC"
  request_terminal_attention "$attention_tty"
}

send_gnome_wayland_jump_notification() {
  # GNOME/Wayland 下保留 Pi 原始消息，点击后再执行 tmux 切回 + attention 跳转
  local icon="$1"
  local title="$2"
  local body="$3"
  local action=""

  if command -v gdbus >/dev/null 2>&1 && command -v dbus-monitor >/dev/null 2>&1; then
    action="$(send_gnome_wayland_jump_notification_dbus "$icon" "$title" "$body")"
  else
    action="$(notify-send -i "$icon" -t 10000 -A "default=切回并聚焦" "$title" "$body" 2>/dev/null || true)"
  fi

  if [[ "$action" == "default" ]]; then
    perform_gnome_wayland_attention_jump "$JUMP_TMUX_TARGET" "$JUMP_TMUX_CLIENT_TTY" "$JUMP_ATTENTION_TTY"
  fi
}

parse_notification_id() {
  local output="$1"

  if [[ "$output" =~ uint32[[:space:]]+([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi

  return 1
}

wait_for_notification_action_dbus() {
  local notification_id="$1"
  local signal_name=""
  local signal_id=""
  local action_name=""
  local line=""

  while IFS= read -r line; do

    case "$line" in
      *"member=ActionInvoked"*)
        signal_name="ActionInvoked"
        signal_id=""
        action_name=""
        continue
        ;;
      *"member=NotificationClosed"*)
        signal_name="NotificationClosed"
        signal_id=""
        action_name=""
        continue
        ;;
    esac

    if [[ "$signal_name" == "ActionInvoked" ]]; then
      if [[ -z "$signal_id" && "$line" =~ ^[[:space:]]*uint32[[:space:]]+([0-9]+)$ ]]; then
        signal_id="${BASH_REMATCH[1]}"
        continue
      fi

      if [[ "$signal_id" == "$notification_id" && "$line" == *'string "'*'"' ]]; then
        action_name="${line#*string \"}"
        action_name="${action_name%\"*}"
        printf '%s' "$action_name"
        return 0
      fi
      continue
    fi

    if [[ "$signal_name" == "NotificationClosed" ]]; then
      if [[ -z "$signal_id" && "$line" =~ ^[[:space:]]*uint32[[:space:]]+([0-9]+)$ ]]; then
        signal_id="${BASH_REMATCH[1]}"
        if [[ "$signal_id" == "$notification_id" ]]; then
          return 0
        fi
      fi
    fi
  done

  return 0
}

send_gnome_wayland_jump_notification_dbus() {
  local icon="$1"
  local title="$2"
  local body="$3"
  local output=""
  local notification_id=""
  local action=""

  coproc DBUS_MONITOR_PROC { dbus-monitor --session "type='signal',interface='org.freedesktop.Notifications'" 2>/dev/null; }

  output="$(gdbus call --session \
    --dest org.freedesktop.Notifications \
    --object-path /org/freedesktop/Notifications \
    --method org.freedesktop.Notifications.Notify \
    'Pi' \
    0 \
    "$icon" \
    "$title" \
    "$body" \
    "['default', '切回并聚焦']" \
    '{}' \
    10000 2>/dev/null || true)"

  notification_id="$(parse_notification_id "$output" || true)"
  if [[ -z "$notification_id" ]]; then
    kill "$DBUS_MONITOR_PROC_PID" >/dev/null 2>&1 || true
    wait "$DBUS_MONITOR_PROC_PID" 2>/dev/null || true
    return 0
  fi

  action="$(wait_for_notification_action_dbus "$notification_id" <&"${DBUS_MONITOR_PROC[0]}")"

  kill "$DBUS_MONITOR_PROC_PID" >/dev/null 2>&1 || true
  wait "$DBUS_MONITOR_PROC_PID" 2>/dev/null || true

  printf '%s' "$action"
}

resolve_jump_context() {
  # 统一收集 Jump 所需上下文
  JUMP_TMUX_TARGET="$(resolve_tmux_target)"
  JUMP_TMUX_CLIENT_TTY="$(resolve_tmux_client_tty "$JUMP_TMUX_TARGET")"
  JUMP_ATTENTION_TTY="$(resolve_attention_tty)"
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
  # - GNOME/Wayland：先展示 Pi 通知，点击后切 tmux 并触发 attention 跳回
  # - 其他环境：保留带动作按钮的 Jump 交互
  local icon="$1"
  local title="$2"
  local body="$3"
  local action=""

  if command -v notify-send >/dev/null 2>&1; then
    resolve_jump_context

    if can_use_gnome_wayland_attention_jump "$JUMP_ATTENTION_TTY"; then
      send_gnome_wayland_jump_notification "$icon" "$title" "$body"
      return 0
    fi

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

main "$@"
