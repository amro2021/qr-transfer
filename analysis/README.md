# Analysing QR Multiplex Lab measurements

1. On each receiving phone, open the lab page, go to **Receive**, fill in the run label and the distance,
   and press **Start run** for every measurement. When finished, press **Download dataset (.zip)**.
2. Run the script on one or more datasets (for example one per phone):

   ```
   pip install pandas numpy scipy matplotlib
   python analyze_qr_lab.py phoneA.zip phoneB.zip -o results
   ```

3. `results/` then holds the figures (PDF for the paper, PNG for slides), `summary_by_scheme.csv/.tex`,
   `summary_by_stream.csv` and `METHODS.md` with the metric definitions.

Good practice for publishable numbers: repeat each scheme × distance at least 5 times, keep lighting
and screen brightness fixed and note them in the run notes, and record the sender screen model and size.
