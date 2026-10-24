import os

if __name__ == "__main__":
    # reeval starts its runner with REEVAL_RUNNER set; anyone else gets the `reeval` command.
    if os.environ.get("REEVAL_RUNNER"):
        from reeval_python.runner import main
    else:
        from reeval_python.cli import main
    main()
