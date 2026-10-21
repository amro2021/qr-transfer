# Measurement datasets

The receiver page (multi/ → Receive → **Save new runs to GitHub**) adds one `.zip` here per save,
named `<phone name>-<UTC time>.zip`. Each push of a new dataset runs the analysis workflow, which
rebuilds `results/` (figures, tables and a results page) from all datasets in this folder.

To leave a dataset out of the analysis, delete or move its `.zip` file.
