#!/bin/zsh

readonly launcher_path="${0:A}"
readonly repository_root="${launcher_path:h}"

exec /bin/zsh -ilc '
  set -u

  readonly repository_root="$1"
  typeset -a pnpm_command
  typeset -i exit_code=0

  if ! cd -- "$repository_root"; then
    exit_code=1
  else
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
      print -u2 "未找到 Node.js/pnpm。请先安装仓库要求的 Node.js，再运行 pnpm install。"
      exit_code=127
    fi

    if (( exit_code == 0 )); then
      export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
      export DSH_DESKTOP_OPEN_DEVTOOLS="${DSH_DESKTOP_OPEN_DEVTOOLS:-0}"
      "${pnpm_command[@]}" run dev:desktop
      exit_code=$?
    fi
  fi

  if (( exit_code != 0 )); then
    print -u2
    print -u2 "桌面端启动失败（退出码 $exit_code）。"
    read -r "?按回车键关闭窗口。"
  fi

  exit "$exit_code"
' start-desktop "$repository_root"
