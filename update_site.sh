#!/bin/bash
# Update pehy.pythonanywhere.com with the current code (prompts for the API token).
cd "$(dirname "$0")"
export PA_USERNAME=${PA_USERNAME:-pehy}
PY=/scratch/project_465002631/Petr/_LOCAL_CONTAINER/run.sh
if [ -x "$PY" ]; then exec "$PY" python deploy/deploy_pythonanywhere.py "$@"; fi
exec python3 deploy/deploy_pythonanywhere.py "$@"
