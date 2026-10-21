# Analysing QR Multiplex Lab measurements

1. On each receiving phone, open the lab page, go to **Receive**, fill in the run label and the distance,
   and press **Start run** for every measurement.
2. Press **Save new runs to GitHub**. The dataset lands in `data/` of the separate data repository
   (default `amro2021/qr-lab-data`), whose workflow rebuilds `results/` there from all datasets.
   The data repository is kept apart so an upload token shared with a class cannot change this website.
   Alternatively press **Download dataset (.zip)**.
3. To run the analysis yourself on one or more datasets (for example one per phone):

   ```
   pip install pandas numpy scipy matplotlib
   python analyze_qr_lab.py phoneA.zip phoneB.zip -o results
   ```

4. `results/` then holds the figures (PDF for the paper, PNG for slides), `summary_by_scheme.csv/.tex`,
   `summary_by_stream.csv` and `METHODS.md` with the metric definitions.

Good practice for publishable numbers: repeat each scheme × distance at least 5 times, keep lighting
and screen brightness fixed and note them in the run notes, and record the sender screen model and size.
