# DM Offline IFC Checker

A Windows desktop app that runs the Dubai Municipality BIM QA/QC checks on a folder of IFC exports and shows the results in one place. Everything runs on your own computer; no file is uploaded.

The app does not replace the DM tools. It carries the official **DM QA/QC checker** and **DM building card generator** inside it, runs them as they are, and presents what they report. Those tools remain the authority.

## What it does

- **New check** — choose, drop or paste the folder that holds the `.ifc` files and run the check. The app warns about file names that do not follow the DM convention (for example `PN476511_BI000001_PA6184096_AR_001.ifc`), which the DM tools reject.
- **Results** — the DM checker's issues by level (Critical, Error, Warning), grouped by issue or row by row, with filters by file and kind of issue. Where the checker names an element, the app adds its name and Revit element ID so you can select it in Revit.
- **Storey areas** — the BUA, GFA, GA and net area the DM building card computes per storey, next to the declared figures, with the difference in m² and percent. Where a storey has no declared figure you can type your drawing figure.
- **Requirements** — what each element needs at Preliminary, Final and Inspection, read from the checker's `IDS.json` rule file.
- **History** — every check is kept on the computer and can be reopened.

A check stops as soon as the DM checker has written its results file. The DM tool would otherwise go on to build `ModelInfoGrid.xlsx`, which on large models adds many minutes and several GB of memory; tick the option on New check if you need that file.

## What you need

- Windows 10 or 11.
- IFC4 exports. The DM checker no longer accepts IFC2x3.

Nothing else: both DM tools are built into the app. To use a newer DM release instead, choose its `.exe` under **Settings**; **Use built-in copy** switches back.

## Run from source

Needs [Node.js](https://nodejs.org) 20 or newer, and the two DM tools unpacked into `tools/` (not kept in git; together about 230 MB):

```
tools/dmbim.qaqcchecker/BIMToolkit.QAQCChecker.App.exe
tools/dmbim.buildingcardgenerator/BIMToolkit.BuildingCardGenerator.App.exe
```

```bash
npm install
npm start
```

## Build the installer

```bash
npm run dist
```

This writes an installer (`DM-QAQC-Checker-<version>-setup.exe`) and a portable `.exe` to `release/`, both with the DM tools inside. The portable `.exe` unpacks everything on each start, so it opens more slowly than the installed app. They are not code-signed, so Windows SmartScreen warns the first time they are run.

## How it is put together

| File | Role |
|---|---|
| `main.js` | Runs the built-in DM tools, reads `QaQcResults.csv` and the building card, looks up element names and Revit IDs in the IFC files, keeps the history. |
| `preload.js` | The fixed list of requests the window may make. |
| `app/` | The window: `index.html`, `app.css`, `app.js`. |
| `tools/` | The two DM tools, copied into the app's resources when it is built. |

Checks are stored in `%APPDATA%\DM QAQC Checker\history`.
