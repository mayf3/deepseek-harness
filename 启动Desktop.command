#!/bin/zsh
# 启动当前仓库的第二个 Desktop 开发实例。
#
# 本脚本为 Web Host、Electron 调试接口和 Harness home 选择独立值，因此可以
# 与另一个仓库中已经运行的 Desktop 同时启动。运行期间请保持终端窗口打开；
# 按 Ctrl-C 结束本次开发运行。

set -u

readonly launcher_path="${0:A}"
readonly repository_root="${launcher_path:h}"

if [[ ! -f "$repository_root/package.json" ]] || ! grep -q '"dev:desktop"' "$repository_root/package.json"; then
  print -u2 "找不到 Desktop 仓库：$repository_root"
  print -u2 '请把本文件放在仓库根目录后重试。按回车键关闭窗口。'
  read -r
  exit 1
fi
if ! cd -- "$repository_root"; then
  print -u2 "无法进入仓库目录：$repository_root"
  read -r
  exit 1
fi

# Finder 启动的是登录 shell；这里仍然显式补上常见工具链路径。
for directory in /opt/homebrew/bin /usr/local/bin "$HOME/.local/share/pnpm"; do
  case ":$PATH:" in
    *":$directory:"*) ;;
    *) [[ -d "$directory" ]] && PATH="$directory:$PATH" ;;
  esac
done
export PATH

typeset -a pnpm_command
readonly local_pnpm="$repository_root/apps/desktop/node_modules/pnpm/bin/pnpm.mjs"
readonly node_path="${commands[node]-}"
readonly pnpm_path="${commands[pnpm]-}"
readonly corepack_path="${commands[corepack]-}"
if [[ -n "$node_path" && -f "$local_pnpm" ]]; then
  pnpm_command=("$node_path" "$local_pnpm")
elif [[ -n "$pnpm_path" ]]; then
  pnpm_command=("$pnpm_path")
elif [[ -n "$corepack_path" ]]; then
  pnpm_command=("$corepack_path" pnpm)
else
  print -u2 '未找到 Node.js/pnpm。请先安装仓库要求的 Node.js，再运行 pnpm install。按回车键关闭窗口。'
  read -r
  exit 127
fi

if [[ ! -d node_modules/.pnpm ]]; then
  print '依赖尚未安装，先执行 pnpm install ...'
  if ! "${pnpm_command[@]}" install; then
    print
    print -u2 'pnpm install 失败。按回车键关闭窗口。'
    read -r
    exit 1
  fi
fi

if (( ! $+commands[lsof] )); then
  print -u2 '找不到 lsof，无法检查 Desktop 端口冲突。按回车键关闭窗口。'
  read -r
  exit 1
fi

typeset -a selected_ports
selected_ports=()
port_already_selected() {
  local port="$1"
  local selected
  for selected in "${selected_ports[@]}"; do
    [[ "$selected" == "$port" ]] && return 0
  done
  return 1
}
port_is_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}
next_free_port() {
  integer candidate="$1"
  while port_is_busy "$candidate" || port_already_selected "$candidate"; do
    (( candidate += 1 ))
  done
  print -r -- "$candidate"
}

# The first Desktop normally uses 19387, 9229, 9222 and 9230. Start searching
# after those values so this instance also avoids another already-isolated run.
readonly web_port="$(next_free_port 19389)"
selected_ports+=("$web_port")
readonly main_inspect_port="$(next_free_port 9329)"
selected_ports+=("$main_inspect_port")
readonly renderer_debug_port="$(next_free_port 9322)"
selected_ports+=("$renderer_debug_port")
readonly host_inspect_port="$(next_free_port 9330)"

readonly repository_name="${repository_root:t}"
readonly default_home="$HOME/.dsh-desktop-${repository_name}-${web_port}"
export DSH_HOME="${DSH_DESKTOP_SECOND_HOME:-$default_home}"
export DSH_DESKTOP_WEB_PORT="$web_port"
export DSH_DESKTOP_MAIN_INSPECT_PORT="$main_inspect_port"
export DSH_DESKTOP_RENDERER_DEBUG_PORT="$renderer_debug_port"
export DSH_DESKTOP_HOST_INSPECT_PORT="$host_inspect_port"
export DSH_DESKTOP_OPEN_DEVTOOLS="${DSH_DESKTOP_OPEN_DEVTOOLS:-0}"

# The preparation process alone may use a verified local proxy.
typeset primary_manifest
if ! primary_manifest="$("$node_path" --input-type=module -e '
  import { resolveDesktopTargetBuildPaths } from "./apps/desktop/scripts/desktop-build-paths.mjs";
  console.log(resolveDesktopTargetBuildPaths().runtime + "/primary-runtime/runtime.json");
')"; then
  print -u2 '无法确定 Desktop 运行时目录。'
  exit 1
fi
if [[ ! -f "$primary_manifest" ]]; then
  (
    unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NODE_USE_ENV_PROXY
    export no_proxy=127.0.0.1,localhost,::1
    export NO_PROXY="$no_proxy"
    if (( $+commands[nc] )); then
      for proxy_port in 7890 7897 1087 8080; do
        if nc -G 2 -z 127.0.0.1 "$proxy_port" >/dev/null 2>&1; then
          export http_proxy="http://127.0.0.1:$proxy_port"
          export https_proxy="$http_proxy"
          export NODE_USE_ENV_PROXY=1
          break
        fi
      done
    fi
    "${pnpm_command[@]}" --dir apps/desktop run prepare:primary-runtime
  )
  if (( $? != 0 )); then
    print -u2 'Desktop 运行时准备失败。按回车键关闭窗口。'
    read -r
    exit 1
  fi
fi
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NODE_USE_ENV_PROXY

# 分支切换可能留下指向已删除 workspace 包的悬空链接；它们会阻塞 Desktop 项目投影。
if [[ -d node_modules/.pnpm/node_modules ]]; then
  while IFS= read -r stale_link; do
    [[ -n "$stale_link" ]] || continue
    print "清理悬空 workspace 链接：$stale_link -> $(readlink "$stale_link")"
    rm -- "$stale_link"
  done < <(find node_modules/.pnpm/node_modules -type l ! -exec test -e {} \; -print 2>/dev/null)
fi

printf '\033]0;DSH Desktop 开发模式（端口 %s）\007' "$web_port"
print 'DSH Desktop 开发模式（隔离实例）'
print "仓库：$repository_root"
print "Harness home：$DSH_HOME"
print "Web Host：127.0.0.1:$web_port"
print "调试端口：Main=$main_inspect_port Renderer=$renderer_debug_port Host=$host_inspect_port"
print

"${pnpm_command[@]}" run dev:desktop
readonly exit_code=$?
if (( exit_code != 0 )); then
  print
  print -u2 "dev:desktop 以状态码 $exit_code 退出，保留窗口以便查看日志。"
  print -u2 '按回车键关闭窗口。'
  read -r
fi
exit "$exit_code"
