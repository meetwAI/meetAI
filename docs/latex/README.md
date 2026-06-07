# meetAI — Graduation Project Thesis (LaTeX)

This folder contains the LaTeX source of the `meetAI` graduation project
thesis, structured according to the doctor-supplied **Graduation Project
Thesis Structural Framework & Guide** (v1.0, April 7, 2026).

## Build

Compile from this directory:

```bash
bash /home/great/dev/GP/meetAI/.claude/skills/latex-document-skill/scripts/compile_latex.sh main.tex
```

The skill's compile script auto-runs `bibtex` when it detects
`\bibliography{references}` and produces `main.pdf`.

The compiled PDF is `main.pdf` (~37 pages at the time of writing).

## File Layout

```
docs/latex/
├── main.tex                 # master document (preamble, front matter, includes)
├── references.bib           # curated BibTeX bibliography (IEEE numerical style)
├── chapters/
│   ├── chapter1.tex         # Introduction
│   ├── chapter2.tex         # Literature Review
│   ├── chapter3.tex         # Analysis and Requirements Engineering
│   ├── chapter4.tex         # System Architecture and Design
│   ├── chapter5.tex         # ML Methodology and Implementation
│   ├── chapter6.tex         # Experimental Design and Evaluation
│   ├── chapter7.tex         # Results and Discussion  (TBD tables)
│   └── chapter8.tex         # Conclusion and Future Work
├── appendices/
│   ├── appendixA.tex        # AI Ethics & Bias Statement
│   ├── appendixB.tex        # Reproducibility Report
│   └── appendixC.tex        # Generative AI (GenAI) Disclosure
└── figures/                 # (empty; figures are TikZ-embedded in chapters)
```

## Section Status

- ✅ Chapter 1 (Introduction) — full content, includes figure, citations
- 🟡 Chapters 2–6, 8 — placeholder structure with `[TODO]` markers; expand
  section by section, KSI compliance is tracked in the
  `Graduation–Project Thesis Structural Framework & Guide.md` file.
- 🟡 Chapter 7 (Results) — full structure with `TBD` placeholder tables for
  ASR / diarization / retrieval / system metrics; replace `\tbd` with real
  values from the experiment log.
- 🟡 Appendices A, B, C — placeholder structure with `[TODO]` markers.

## Notes

- `\tbd` renders a clearly visible orange `TBD` placeholder (use for
  numeric values that will be filled from the experiment log).
- `\todo{...}` renders an orange `TODO:` marker (use for prose to be
  written).
- `mathpazo` is used (Palatino) because `newpxtext` is not in the
  default TeX Live install on this machine; swap to New PX later if
  desired.
- Citations are in IEEE numerical style (`\citep{key}` → `[1]`).
