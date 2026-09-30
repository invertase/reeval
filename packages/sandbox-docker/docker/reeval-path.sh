# /etc/profile.d/00-reeval-path.sh in every image reeval builds. Debian's /etc/profile resets
# PATH in login shells (`bash -l`, which some agents run commands in), dropping what the image's
# `ENV PATH` added, such as dart:stable's /usr/lib/dart/bin. The shell's initial environment
# still has the PATH it started with: put that back first, then what /etc/profile set.
reeval_path=$(tr '\0' '\n' 2>/dev/null </proc/$$/environ | sed -n 's/^PATH=//p' | head -n 1)
if [ -n "$reeval_path" ]; then
  reeval_rest=$PATH:
  PATH=$reeval_path
  while [ -n "$reeval_rest" ]; do
    reeval_dir=${reeval_rest%%:*}
    reeval_rest=${reeval_rest#*:}
    if [ -n "$reeval_dir" ]; then
      case ":$PATH:" in
        *":$reeval_dir:"*) ;;
        *) PATH=$PATH:$reeval_dir ;;
      esac
    fi
  done
  export PATH
fi
unset reeval_path reeval_rest reeval_dir
