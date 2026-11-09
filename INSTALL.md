# Better Captions: install & use in Premiere Pro

Better Captions comes in two forms. Install **one** of them:

| | Extension (CEP) | UXP plugin |
|---|---|---|
| Opens from | **Window → Extensions → Better Captions** | Window → UXP Plugins → Better Captions |
| Installs with | `Install Extension.bat` (no admin, no Creative Cloud) | Double-click `BetterCaptions.ccx` (Creative Cloud) |
| Files | `BetterCaptions-Extension\com.bettercaptions.cep\` | `BetterCaptions.ccx` |
| Offline captions | Yes | Yes |
| Uses Premiere's own transcript | No (offline captions only) | Yes, as a fallback |

## Easiest: BetterCaptionsSetup.exe

1. **Close Premiere Pro.**
2. Double-click **`BetterCaptionsSetup.exe`** and click **Install**. No admin rights are needed.
   - The first time, Windows SmartScreen may say *"Windows protected your PC"*, because the installer isn't code-signed. Click **More info → Run anyway**.
   - After installing the panel, setup downloads the offline speech engine into `%APPDATA%\BetterCaptions\engine`, with a progress bar: whisper.cpp, ffmpeg, the speech detector and the **Large v3 Turbo** model, about 700 MB in total. This happens once; captions then work without internet.
   - Parts you already have are skipped. If you click **Cancel** or lose your connection, click **Reinstall** later and it carries on where it stopped. If the download can't finish, the panel is still installed and its **Set up offline engine** button can do the download instead.
   - Older speech models (Base, Small) from earlier versions are deleted to free space.
3. Click **Open Premiere Pro**, then go to **Window → Extensions → Better Captions**.

For an install without the download (for example, to copy the engine over yourself), run `BetterCaptionsSetup.exe /noengine`.

To uninstall: **Settings → Apps → Installed apps → Better Captions for Premiere Pro → Uninstall**, or run the setup again and click **Uninstall**. It asks whether to also delete the downloaded speech engine and saved captions.

The `.exe` is a single file (about 150 KB) with the extension packed inside, so you can copy it to another Windows 10/11 laptop and install there the same way. It installs the CEP extension described below.

## Extension (CEP): your own third-party extension, no UXP, no Creative Cloud

Same extension as the `.exe`, installed with a script instead:

1. **Close Premiere Pro.**
2. Double-click **`Install Extension.bat`** in `D:\pr captions`. No admin prompt.
3. Open Premiere Pro, then go to **Window → Extensions → Better Captions**.

To remove it: close Premiere and double-click **`Uninstall Extension.bat`**.

What the installer does:
- Copies `BetterCaptions-Extension\com.bettercaptions.cep` to `%APPDATA%\Adobe\CEP\extensions\com.bettercaptions.cep`, the same folder other third-party extensions like Motion Bro use.
- Makes sure Premiere allows unsigned extensions: `PlayerDebugMode = 1` under `HKCU\Software\Adobe\CSXS.9`–`CSXS.16`. On this PC it was already on, so nothing changes.

To install it on another Windows PC, copy `Install Extension.bat`, `install-extension.ps1` and the `BetterCaptions-Extension` folder there together, and run the .bat.

**Mac:** copy `com.bettercaptions.cep` to `~/Library/Application Support/Adobe/CEP/extensions/`, run `defaults write com.adobe.CSXS.12 PlayerDebugMode 1`, and install the engine with `brew install whisper-cpp ffmpeg`.

**Note on future Premiere versions:** this PC has Premiere 26.2, which loads unsigned extensions. Some people report that Premiere **26.5** rejects unsigned extensions even with PlayerDebugMode on. If that happens after an update, the extension needs to be signed (packaged as a `.zxp` with a certificate), or you can use the UXP plugin below.

The extension keeps its offline engine and saved captions in `%APPDATA%\BetterCaptions`.

## UXP plugin (alternative)

### With Creative Cloud
1. Close Premiere Pro.
2. Double-click **`BetterCaptions.ccx`** and follow the Adobe Creative Cloud prompt to click **Install**.
3. Open Premiere Pro, then go to **Window → UXP Plugins → Better Captions**.

## Using it

1. Open a sequence that has dialogue. Save the project first, because exported captions go in a `Better Captions` folder next to the project file.
2. In the panel, open **Offline Captions**:
   - The speech engine is normally already there, because `BetterCaptionsSetup.exe` downloads it. If it isn't (you used the `.bat` installer, or the download was cancelled), click **Set up offline engine**. This downloads whisper.cpp (speech recognition), ffmpeg (audio tools), a 1 MB speech detector and the Large v3 Turbo speech model, about 700 MB. After that, no internet is needed.
   - Choose what to caption:
     - **Whole timeline:** every unmuted audio track, mixed at its timeline position. In the extension, **Scan audio tracks** lists your tracks so you can tick which ones to use, and **Caption each track separately** transcribes each track on its own: one speaker per track (named after the track), optional **Colour each speaker**, and overlapping speech shown as stacked captions. TXT exports then label each line with the speaker.
     - **Selected clips** (extension version): select or copy (Ctrl+C) clips in the timeline, click in the panel, and press **Ctrl+V**, or click **Use selected timeline clips**. Only those clips are transcribed, at their places on the timeline.
     - **Audio file** (extension version): drag a file from Explorer **or from Premiere's Project panel** onto the Offline Captions area, paste a file copied in Explorer (Ctrl+V), click **Use Project panel selection**, or click the drop zone to choose a file. If the file is already used in the sequence, the start time is set automatically; otherwise set **Captions start at** (or click **Use playhead**) so the captions line up.
   - Pick a **Language**. **Set the language your video is in** rather than auto-detect if you can. Captions always use the **Large v3 Turbo** model, which is accurate across languages and with music or noise. There's no model to choose.
   - Click **Generate captions**. A progress bar shows each step, and you can cancel.
   - Only parts with speech are transcribed, so music and silence don't turn into made-up captions such as "Music playing".
3. Pick a look from **Presets** (click a card to apply it), or build your own:
   - **+ Save current look** saves the font, colours, stroke, background, shadow, glow, position, animation and fades as a named preset. Presets are stored on your computer (`%APPDATA%\BetterCaptions\presets`), not in the project, so they're available in every project.
   - The **⋯** on your own presets: **Rename**, **Update to current look**, **Export…** (a `.bcpreset` file you can share or move to another computer) and **Delete**. **Import…** loads `.bcpreset` files; **Export all…** saves your whole library in one file.
   - **Fonts:** the font picker lists the fonts installed on your computer (including fonts installed just for your user), each shown in its own typeface, with search. **Add font file…** (in the picker) uses a `.ttf`/`.otf` file without installing it; added fonts are kept in `%APPDATA%\BetterCaptions\fonts` and appear under **Your added fonts**.
   - Note for Sinhala: "FM" fonts (FM Gemunu, etc.) are legacy fonts that don't display Unicode Sinhala, which is what the transcription produces. Use a Unicode Sinhala font such as Nirmala UI, Iskoola Pota or Noto Sans Sinhala.

   Then fine-tune the style and the animation, and check them in the preview:
   - **Font & Style:** font, colour, stroke, background, drop shadow, and **Glow** (colour, size, strength, opacity, and an option to glow only the word being spoken).
   - **Animation:** how words appear: **None**, Fade, Type, Pop, Karaoke, Bounce, Slide up, Drop, Elastic, Blur in, Wave, Box (highlight box behind the spoken word) or Spotlight (spoken word grows and lights up, the rest dim). Easing curves come from the GSAP animation library. Plus **Fade In / Out** for each caption, with its own durations and an optional motion: Plain, Slide, Zoom or Blur.
4. **Add to timeline** (extension version):
   - **Add animated captions to timeline:** renders the captions exactly as previewed (style, glow, animation, fades) into one transparent video clip (ProRes 4444) and places it on the top video track at the time the captions start. A new track is added if the top one is busy, and the clip is moved to your chosen caption position. Needs the offline engine (it uses ffmpeg).
   - **Add as editable Premiere captions:** plain captions on a Premiere caption track that you can edit and restyle (no animation).
   - Both keep their files in a **Better Captions** folder next to your project file (save the project first). **Save a file instead: SRT / TXT** is still there if you want a file.
   - In the UXP plugin version: **Export SRT**, **Export TXT** and **Export styled overlay (PNG frames)**.

Notes:
- Offline captions are saved per sequence and reload when you reopen the panel.
- Muted tracks and disabled clips are skipped.
- **Nested sequences are supported** (extension version) in Whole timeline, Selected clips and per-track mode, and in Beat Markers: the audio inside a nest (and nests inside nests) is used, only the part visible on your timeline, mapped to where the nest sits, including sped-up or slowed-down nests. Dropping or selecting a nested sequence from the Project panel works too: captions are placed where the nest sits in the open sequence, and beat markers can go inside the nested sequence or on the main sequence.
- If you edit the timeline (move or trim clips), click **Regenerate** so the timings match again.

## The home menu

The panel opens on a menu with three tools: **Captions**, **Beat Markers** and **LUT Preview**. Each shows what it's doing (captions ready, last BPM found, LUT picked). Click one to open it; the arrow at the top left brings you back. The panel uses Premiere's own greys and selection blue, with Lucide icons.

## LUT Preview (extension version)

1. Move the playhead over a clip and open **LUT Preview**. It grabs that frame automatically:
   - **Clip** uses the clip's original image (best for log footage and conversion LUTs).
   - **Program** uses what the Program monitor shows, with your current effects.
   - Click **Grab frame** after moving the playhead.
2. Browse the **Library**: your Premiere LUTs, Adobe's shared LUT folder, and any folder you add with **+ Add folder**. Pick a folder, or search all LUTs by name. Every thumbnail is your own frame with that LUT applied.
3. **Hover** a thumbnail to preview it large. Drag the split line to compare **Original** and the LUT, set **Intensity**, or click the compare button to see the full frame. Star LUTs to keep them under **Favourites**.
4. **Click** a LUT to put it on the timeline. The row under the preview shows which clip: the clips you selected, or else the top clip under the playhead. **Apply on** chooses where it goes:
   - **Adjustment layer** (the default): the panel creates an adjustment layer named "Better Captions LUT" over those clips, on the first free video track above them, adding a track if needed. It then adds Lumetri Color and chooses the LUT in its Creative > Look. Your clips stay untouched.
   - **Clip**: Lumetri Color goes on the clips themselves.

   With **Live** on (the default), each LUT you click replaces the last one on the same layer, so the Program monitor shows the real result, and the Intensity slider follows. **Keep** leaves it; **Undo** removes the adjustment layer, or puts the clip's Look back. With Live off, click **Add on adjustment layer** or **Put on clip**.
5. **How the LUT is chosen.** Premiere's scripting can't load a LUT file, but it can choose an entry in Lumetri's Look menu. That menu lists the LUTs in Premiere's Creative LUT folders, read when Premiere starts:
   - LUTs already in those folders work straight away. That includes the packs in `C:\Program Files\Adobe\Common\LUTs\Creative` and Premiere's own Creative LUTs. The first time you use one, with the clip under the playhead, the panel finds its menu entry by comparing the Program monitor with the LUT, then remembers it.
   - Any other LUT is copied into your own Creative folder (`%APPDATA%\Adobe\Common\LUTs\Creative`) the first time you click it. **Restart Premiere once**; after that, clicking it applies it automatically. **Add favourites to Look menu** does this for all your starred LUTs at once.
   - **Copy Lumetri details** (shown after an error) copies information for a bug report. **Show in folder** opens the LUT in Explorer.

Only `.cube` LUTs are listed (that's nearly all of them); macOS junk files from LUT packs are skipped.

## Beat Markers (extension version)

Open **Beat Markers** in the panel to find the tempo and beats of your music and drop coloured markers on them, so you can cut to the beat:

1. Choose the music:
   - **Selected clips:** select the music clip(s) in the timeline.
   - **Audio track:** pick a track.
   - **Project item:** select it in the Project panel. Markers go on the clip itself (visible in the Source monitor), or on the sequence if the clip is used in it.
2. Click **Analyse beats**. You get the BPM and a confidence rating (green = steady beat, yellow = check by ear, red = the tempo varies).
3. Choose **Every beat**, **Every 2nd** or **Bar starts**, and **Beats per bar** (4 for most music).
4. Click **Add beat markers**. Colours: **red** = first beat of a bar, **yellow** = middle of the bar, **blue** = other beats. Jump between markers with **Shift+M** / **Ctrl+Shift+M**.
5. **Remove beat markers** removes only the markers this tool added.

Beat detection uses the open-source *music-tempo* library (MIT licence, Beatroot algorithm) and the ffmpeg from the offline engine, so it works offline and with any audio or video format.

## Rebuilding after changes

Installer `.exe` (also rebuilds the extension):

```bash
cd "D:\pr captions\Better-Captions-Premiere" && npm run installer
```

Then copy `installer\bin\BetterCaptionsSetup.exe` to `D:\pr captions\`.

Extension (CEP):

```bash
cd "D:\pr captions\Better-Captions-Premiere" && npm run cep
```

Then copy `cep-dist\com.bettercaptions.cep` into `D:\pr captions\BetterCaptions-Extension\`.

UXP plugin:

```bash
cd "D:\pr captions\Better-Captions-Premiere" && npm run ccx
```
