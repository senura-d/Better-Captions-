// Better Captions: ExtendScript side of the CEP extension.
// Every function returns a JSON string so the panel can JSON.parse it.

var BC_TICKS_PER_SECOND = 254016000000;

// Escapes a string for JSON one character at a time. (A regular expression
// containing a NUL range made ExtendScript reject this whole file.)
function bc_quote(s) {
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (code < 32 || code === 0x2028 || code === 0x2029) {
      var hex = code.toString(16);
      out += "\\u" + "0000".substr(hex.length) + hex;
    } else out += c;
  }
  return out + '"';
}

function bc_json(value) {
  var t = typeof value;
  if (value === null || value === undefined) return "null";
  if (t === "number") return isFinite(value) ? String(value) : "null";
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return bc_quote(value);
  if (value instanceof Array) {
    var items = [];
    for (var i = 0; i < value.length; i++) items.push(bc_json(value[i]));
    return "[" + items.join(",") + "]";
  }
  var props = [];
  for (var key in value) {
    if (value.hasOwnProperty(key)) props.push(bc_json(String(key)) + ":" + bc_json(value[key]));
  }
  return "{" + props.join(",") + "}";
}

function bc_error(e) {
  return bc_json({ success: false, error: String(e && e.message ? e.message : e) });
}

function bc_getActiveSequenceId() {
  var seq = app.project && app.project.activeSequence;
  return bc_json(seq ? String(seq.sequenceID) : null);
}

function bc_getActiveSequenceInfo() {
  try {
    var seq = app.project && app.project.activeSequence;
    if (!seq) return "null";

    var ticksPerFrame = parseFloat(seq.timebase);
    var frameRate = ticksPerFrame > 0 ? BC_TICKS_PER_SECOND / ticksPerFrame : 24;

    var width = 0;
    var height = 0;
    try {
      width = seq.frameSizeHorizontal;
      height = seq.frameSizeVertical;
    } catch (e1) {}
    if (!width || !height) {
      try {
        var settings = seq.getSettings();
        width = settings.videoFrameWidth;
        height = settings.videoFrameHeight;
      } catch (e2) {}
    }

    var end = parseFloat(seq.end);
    if (!(end > 0)) {
      try { end = parseFloat(seq.getOutPointAsTime().ticks); } catch (e3) { end = 0; }
    }

    return bc_json({
      id: String(seq.sequenceID),
      name: String(seq.name),
      duration: end / BC_TICKS_PER_SECOND,
      frameRate: Math.round(frameRate * 100) / 100,
      frameWidth: width || 1920,
      frameHeight: height || 1080
    });
  } catch (e) {
    return bc_json({ error: String(e && e.message ? e.message : e) });
  }
}

function bc_getProjectPath() {
  return bc_json(app.project ? app.project.path : "");
}

// Describes one timeline clip: where it sits on the timeline and which part of
// its source file it plays. Returns null (and notes why) when it can't be used.
function bc_describeClip(clip, skipped) {
  if (clip.disabled) return null;
  var item = clip.projectItem;
  var name = clip.name || (item ? item.name : "Untitled clip");
  var path = "";
  try {
    if (item && !(item.isSequence && item.isSequence())) path = item.getMediaPath();
  } catch (e1) {}
  if (!path) {
    skipped.push(name + " (no media file)");
    return null;
  }

  var start = clip.start.seconds;
  var end = clip.end.seconds;
  if (end <= start) return null;

  var speed = 1;
  var reversed = false;
  try {
    speed = Math.abs(clip.getSpeed()) || 1;
    reversed = !!clip.isSpeedReversed();
  } catch (e2) {}

  var inPoint = clip.inPoint.seconds;
  var outPoint = clip.outPoint.seconds;
  var sourceDuration = Math.abs(outPoint - inPoint);
  if (!(sourceDuration > 0)) sourceDuration = (end - start) * speed;

  return {
    name: name,
    path: path,
    start: start,
    end: end,
    sourceIn: Math.max(0, Math.min(inPoint, outPoint)),
    sourceDuration: sourceDuration,
    speed: speed,
    reversed: reversed
  };
}

// ---------- nested sequences ----------

function bc_isSequenceItem(item) {
  try {
    return !!(item && item.isSequence && item.isSequence());
  } catch (e) {
    return false;
  }
}

function bc_sequenceForItem(item) {
  var seqs = app.project.sequences;
  for (var i = 0; i < seqs.numSequences; i++) {
    try {
      if (seqs[i].projectItem && seqs[i].projectItem.nodeId === item.nodeId) return seqs[i];
    } catch (e) {}
  }
  return null;
}

// The audio a timeline clip plays, as plain media clips on the outer timeline.
// A nested sequence is opened (recursively) and each of its audio clips is cut
// to the part of the nest that is visible, then mapped to the outer timeline
// (including the nested clip's speed). Ordinary clips come back as themselves.
function bc_clipsFromTrackItem(clip, skipped, depth) {
  if (clip.disabled) return [];
  var item = clip.projectItem;
  if (!bc_isSequenceItem(item)) {
    var leaf = bc_describeClip(clip, skipped);
    return leaf ? [leaf] : [];
  }

  var name = clip.name || item.name;
  if (depth > 6) {
    skipped.push(name + " (nested too deeply)");
    return [];
  }
  var inner = bc_sequenceForItem(item);
  if (!inner) {
    skipped.push(name + " (nested sequence not found)");
    return [];
  }

  var outerSpeed = 1;
  var reversed = false;
  try {
    outerSpeed = Math.abs(clip.getSpeed()) || 1;
    reversed = !!clip.isSpeedReversed();
  } catch (e1) {}
  if (reversed) {
    skipped.push(name + " (reversed nested clip)");
    return [];
  }

  // The stretch of the nested sequence's own timeline that this clip shows.
  var inT = clip.inPoint.seconds;
  var outT = clip.outPoint.seconds;
  if (!(outT > inT)) outT = inT + (clip.end.seconds - clip.start.seconds) * outerSpeed;
  var outerStart = clip.start.seconds;

  var result = [];
  for (var t = 0; t < inner.audioTracks.numTracks; t++) {
    var track = inner.audioTracks[t];
    if (track.isMuted()) continue;
    for (var c = 0; c < track.clips.numItems; c++) {
      var subs = bc_clipsFromTrackItem(track.clips[c], skipped, depth + 1);
      for (var k = 0; k < subs.length; k++) {
        var s = subs[k];
        var a = Math.max(s.start, inT);
        var b = Math.min(s.end, outT);
        if (!(b > a)) continue;
        result.push({
          name: name + " > " + s.name,
          path: s.path,
          start: outerStart + (a - inT) / outerSpeed,
          end: outerStart + (b - inT) / outerSpeed,
          sourceIn: s.sourceIn + (a - s.start) * s.speed,
          sourceDuration: (b - a) * s.speed,
          speed: s.speed * outerSpeed,
          reversed: s.reversed
        });
      }
    }
  }
  if (!result.length) skipped.push(name + " (no audio inside the nested sequence)");
  return result;
}

function bc_sequenceSeconds(seq) {
  return parseFloat(seq.end) / BC_TICKS_PER_SECOND;
}

// Every enabled clip on every unmuted audio track.
function bc_getTimelineAudioClips() {
  try {
    var seq = app.project && app.project.activeSequence;
    if (!seq) return bc_json({ success: false, error: "Open a sequence first." });

    var clips = [];
    var skipped = [];
    var tracks = [];
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var track = seq.audioTracks[t];
      var muted = track.isMuted();
      var label = "A" + (t + 1);
      var name = track.name && track.name !== "Audio " + (t + 1) ? label + " " + track.name : label;
      var count = 0;
      if (!muted) {
        for (var c = 0; c < track.clips.numItems; c++) {
          var found = bc_clipsFromTrackItem(track.clips[c], skipped, 0);
          for (var k = 0; k < found.length; k++) {
            found[k].track = t;
            clips.push(found[k]);
          }
          if (found.length) count++;
        }
      }
      tracks.push({ index: t, name: name, muted: muted, clipCount: count });
    }
    return bc_json({ success: true, clips: clips, skipped: skipped, tracks: tracks, duration: bc_sequenceSeconds(seq) });
  } catch (e) {
    return bc_error(e);
  }
}

// The clips selected (or just copied) in the timeline. Audio clips are used when
// any are selected; if only video clips are selected, their audio is used.
function bc_getSelectedClips() {
  try {
    var seq = app.project && app.project.activeSequence;
    if (!seq) return bc_json({ success: false, error: "Open a sequence first." });
    if (typeof seq.getSelection !== "function") {
      return bc_json({ success: false, error: "This version of Premiere can't report the timeline selection." });
    }

    var selection = seq.getSelection() || [];
    var audio = [];
    var video = [];
    for (var i = 0; i < selection.length; i++) {
      var item = selection[i];
      if (item.mediaType === "Audio") audio.push(item);
      else if (item.mediaType === "Video") video.push(item);
    }
    var chosen = audio.length ? audio : video;

    var clips = [];
    var skipped = [];
    var seen = {};
    for (var c = 0; c < chosen.length; c++) {
      var found = bc_clipsFromTrackItem(chosen[c], skipped, 0);
      for (var k = 0; k < found.length; k++) {
        var info = found[k];
        var key = info.path + "|" + info.start + "|" + info.sourceIn;
        if (seen[key]) continue;
        seen[key] = true;
        clips.push(info);
      }
    }
    return bc_json({ success: true, clips: clips, skipped: skipped, duration: bc_sequenceSeconds(seq) });
  } catch (e) {
    return bc_error(e);
  }
}

// Where time 0 of a media file falls on the active sequence's timeline, based on
// the first clip that uses it (null when the file isn't used in the sequence).
function bc_findMediaOffset(seq, path) {
  var groups = [seq.audioTracks, seq.videoTracks];
  for (var g = 0; g < groups.length; g++) {
    for (var t = 0; t < groups[g].numTracks; t++) {
      var track = groups[g][t];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        try {
          if (clip.projectItem && clip.projectItem.getMediaPath() === path) {
            return clip.start.seconds - clip.inPoint.seconds;
          }
        } catch (e1) {}
      }
    }
  }
  return null;
}

// Where a nested sequence's own 00:00 falls in `seq` (first use), or null.
function bc_findNestOffset(seq, nodeId) {
  var groups = [seq.audioTracks, seq.videoTracks];
  for (var g = 0; g < groups.length; g++) {
    for (var t = 0; t < groups[g].numTracks; t++) {
      var track = groups[g][t];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        try {
          if (clip.projectItem && clip.projectItem.nodeId === nodeId) return clip.start.seconds - clip.inPoint.seconds;
        } catch (e1) {}
      }
    }
  }
  return null;
}

// Media selected (or just dragged) in the Project panel.
function bc_getProjectSelection() {
  try {
    if (typeof app.getCurrentProjectViewSelection !== "function") {
      return bc_json({ success: false, error: "This version of Premiere can't report the Project panel selection." });
    }
    var selection = app.getCurrentProjectViewSelection() || [];
    var seq = app.project.activeSequence;
    var items = [];
    for (var i = 0; i < selection.length; i++) {
      var item = selection[i];
      if (bc_isSequenceItem(item)) {
        // A nested sequence: its audio clips (on its own timeline), and where its
        // 00:00 sits in the active sequence when it's used there.
        var inner = bc_sequenceForItem(item);
        if (!inner) continue;
        var skipped = [];
        var clips = [];
        for (var t = 0; t < inner.audioTracks.numTracks; t++) {
          if (inner.audioTracks[t].isMuted()) continue;
          for (var c = 0; c < inner.audioTracks[t].clips.numItems; c++) {
            var found = bc_clipsFromTrackItem(inner.audioTracks[t].clips[c], skipped, 1);
            for (var k = 0; k < found.length; k++) clips.push(found[k]);
          }
        }
        items.push({
          name: item.name,
          path: "",
          sequenceNodeId: item.nodeId,
          clips: clips,
          skipped: skipped,
          timelineOffset: seq ? bc_findNestOffset(seq, item.nodeId) : null
        });
        continue;
      }
      var path = "";
      try {
        path = item.getMediaPath();
      } catch (e1) {}
      if (!path) continue;
      items.push({
        name: item.name,
        path: path,
        timelineOffset: seq ? bc_findMediaOffset(seq, path) : null
      });
    }
    return bc_json({ success: true, items: items });
  } catch (e) {
    return bc_error(e);
  }
}

function bc_findLatestItem(baseName) {
  var root = app.project.rootItem;
  var found = null;
  for (var i = 0; i < root.children.numItems; i++) {
    var child = root.children[i];
    if (child.type === ProjectItemType.CLIP && child.name.indexOf(baseName) !== -1) found = child;
  }
  return found;
}

function bc_importImageSequence(firstFramePath, baseName, frameRate) {
  try {
    var ok = app.project.importFiles([firstFramePath], true, app.project.rootItem, true);
    if (!ok) return bc_json({ success: false, error: "Import failed" });
    var item = bc_findLatestItem(baseName);
    if (item && item.setOverrideFrameRate) item.setOverrideFrameRate(frameRate);
    return bc_json({ success: true });
  } catch (e) {
    return bc_error(e);
  }
}

// Captions are rendered from sequence time 0, so placing the overlay at 0 on
// an empty video track keeps every caption in sync with the timeline audio.
function bc_placeCaptionsOnTimeline(baseName) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return bc_json({ success: false, error: "No active sequence." });
    var item = bc_findLatestItem(baseName);
    if (!item) return bc_json({ success: false, error: "Could not find the imported captions in the project." });

    for (var i = seq.videoTracks.numTracks - 1; i >= 0; i--) {
      var track = seq.videoTracks[i];
      if (track.clips.numItems === 0) {
        track.overwriteClip(item, 0);
        return bc_json({ success: true, trackNumber: i + 1 });
      }
    }
    return bc_json({
      success: false,
      error: "Captions were imported into the project, but there's no empty video track. Add one above your footage and export again, or drag the captions clip to 00:00 yourself."
    });
  } catch (e) {
    return bc_error(e);
  }
}

function bc_getPlayheadSeconds() {
  try {
    var seq = app.project.activeSequence;
    return bc_json(seq ? seq.getPlayerPosition().seconds : 0);
  } catch (e) {
    return "0";
  }
}

// Imports an .srt and, where Premiere supports it, adds it to the active
// sequence as a subtitle caption track starting at 00:00.
function bc_importCaptions(filePath) {
  try {
    var seq = app.project.activeSequence;
    if (!app.project.importFiles([filePath], true, app.project.rootItem, false)) {
      return bc_json({ success: false, error: "Premiere couldn't import the caption file." });
    }
    var cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    var fileName = filePath.substr(cut + 1);
    var root = app.project.rootItem;
    var item = null;
    for (var i = 0; i < root.children.numItems; i++) {
      if (root.children[i].name === fileName) item = root.children[i];
    }
    if (!item) return bc_json({ success: true, placed: false });
    if (!seq || typeof seq.createCaptionTrack !== "function") return bc_json({ success: true, placed: false });
    var format = (typeof Sequence !== "undefined" && Sequence.CAPTION_FORMAT_SUBTITLE) ? Sequence.CAPTION_FORMAT_SUBTITLE : undefined;
    if (format !== undefined) seq.createCaptionTrack(item, 0, format);
    else seq.createCaptionTrack(item, 0);
    return bc_json({ success: true, placed: true });
  } catch (e) {
    return bc_error(e);
  }
}


function bc_findItemByName(name) {
  var root = app.project.rootItem;
  var found = null;
  for (var i = 0; i < root.children.numItems; i++) {
    if (root.children[i].name === name) found = root.children[i];
  }
  return found;
}

function bc_trackIsFree(track, from, to) {
  for (var c = 0; c < track.clips.numItems; c++) {
    var clip = track.clips[c];
    if (clip.start.seconds < to && clip.end.seconds > from) return false;
  }
  return true;
}

// Places the rendered caption clip at `startSeconds` on the highest video track
// that's free for its whole length (adding a track if none is), then moves it to
// the caption position chosen in the panel (normalised 0..1 frame coordinates).
function bc_placeOverlay(filePath, startSeconds, durationSeconds, posX, posY) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return bc_json({ success: false, error: "No active sequence." });
    if (!app.project.importFiles([filePath], true, app.project.rootItem, false)) {
      return bc_json({ success: false, error: "Premiere couldn't import the caption video." });
    }
    var cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    var item = bc_findItemByName(filePath.substr(cut + 1));
    if (!item) return bc_json({ success: false, error: "Couldn't find the imported caption video in the project." });

    // Captions must sit above the footage, so only the top video track will do:
    // use it if it's free for the captions' span, otherwise add a new track on top.
    var endSeconds = startSeconds + durationSeconds;
    var target = seq.videoTracks.numTracks - 1;
    var addedTrack = false;
    if (!bc_trackIsFree(seq.videoTracks[target], startSeconds, endSeconds)) {
      var before = seq.videoTracks.numTracks;
      try {
        app.enableQE();
        qe.project.getActiveSequence().addTracks(1, before, 0);
      } catch (eAdd) {}
      if (seq.videoTracks.numTracks > before) {
        target = seq.videoTracks.numTracks - 1;
        addedTrack = true;
      } else {
        return bc_json({
          success: false,
          error: "The caption video was imported, but the top video track is busy at that time. Add an empty video track above your footage and try again."
        });
      }
    }

    var track = seq.videoTracks[target];
    track.overwriteClip(item, startSeconds);

    var positioned = false;
    for (var c = 0; c < track.clips.numItems; c++) {
      var clip = track.clips[c];
      if (clip.projectItem && clip.projectItem.nodeId === item.nodeId && Math.abs(clip.start.seconds - startSeconds) < 0.05) {
        for (var k = 0; k < clip.components.numItems; k++) {
          var comp = clip.components[k];
          if (comp.matchName === "AE.ADBE Motion" || comp.displayName === "Motion") {
            for (var p = 0; p < comp.properties.numItems; p++) {
              var prop = comp.properties[p];
              if (prop.displayName === "Position" || p === 0) {
                prop.setValue([posX, posY], true);
                positioned = true;
                break;
              }
            }
            break;
          }
        }
        break;
      }
    }
    return bc_json({ success: true, trackNumber: target + 1, addedTrack: addedTrack, positioned: positioned });
  } catch (e) {
    return bc_error(e);
  }
}


// ---------- beat markers ----------

var BC_BEAT_TAG = "Better Captions beat marker";

// Project items are found by media path, searching inside bins too.
function bc_findItemByMediaPath(folder, path) {
  for (var i = 0; i < folder.children.numItems; i++) {
    var child = folder.children[i];
    if (child.type === ProjectItemType.BIN) {
      var inside = bc_findItemByMediaPath(child, path);
      if (inside) return inside;
    } else {
      try {
        if (child.getMediaPath() === path) return child;
      } catch (e) {}
    }
  }
  return null;
}

// "sequence" -> the active sequence's markers; "clip" -> the markers of the
// project item whose media file is `itemPath` (shown in the Source monitor).
function bc_markerCollection(target, itemPath) {
  if (target === "nested") {
    // itemPath carries the nested sequence's project item nodeId.
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) {
      try {
        if (seqs[i].projectItem.nodeId === itemPath) return seqs[i].markers;
      } catch (e) {}
    }
    return null;
  }
  if (target === "clip") {
    var item = bc_findItemByMediaPath(app.project.rootItem, itemPath);
    return item ? item.getMarkers() : null;
  }
  var seq = app.project.activeSequence;
  return seq ? seq.markers : null;
}

// Marker colours (Premiere's order): 1 red, 4 yellow, 6 blue.
// `beatsCsv` is "time:bar:beat,..." with times in seconds.
function bc_addBeatMarkers(target, itemPath, beatsCsv, bpm, beatsPerBar) {
  try {
    var markers = bc_markerCollection(target, itemPath);
    if (!markers) return bc_json({ success: false, error: target === "sequence" ? "No active sequence." : "Couldn't find that item in the project." });
    var entries = beatsCsv ? beatsCsv.split(",") : [];
    var half = Math.floor(beatsPerBar / 2) + 1;
    var added = 0;
    var colored = true;
    for (var i = 0; i < entries.length; i++) {
      var parts = entries[i].split(":");
      var time = parseFloat(parts[0]);
      var bar = parseInt(parts[1], 10);
      var beat = parseInt(parts[2], 10);
      if (!(time >= 0)) continue;
      var m = markers.createMarker(time);
      m.name = bar > 0 ? "Bar " + bar + " \u00B7 Beat " + beat : "Pickup \u00B7 Beat " + beat;
      m.comments = BC_BEAT_TAG + " \u00B7 " + bpm + " BPM";
      try {
        m.setColorByIndex(beat === 1 ? 1 : (beatsPerBar % 2 === 0 && beat === half ? 4 : 6));
      } catch (eColor) {
        colored = false;
      }
      added++;
    }
    return bc_json({ success: true, added: added, colored: colored });
  } catch (e) {
    return bc_error(e);
  }
}

function bc_removeBeatMarkers(target, itemPath) {
  try {
    var markers = bc_markerCollection(target, itemPath);
    if (!markers) return bc_json({ success: false, error: target === "sequence" ? "No active sequence." : "Couldn't find that item in the project." });
    var removed = 0;
    var m = markers.getFirstMarker();
    while (m) {
      var next = markers.getNextMarker(m);
      if (m.comments && m.comments.indexOf(BC_BEAT_TAG) === 0) {
        markers.deleteMarker(m);
        removed++;
      }
      m = next;
    }
    return bc_json({ success: true, removed: removed });
  } catch (e) {
    return bc_error(e);
  }
}


// ---------- LUT preview ----------

// The topmost visible video clip under `time` in `seq`, opening nested
// sequences, as { path, sourceTime, name } (source time in the media file).
function bc_videoAt(seq, time, depth) {
  for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
    var track = seq.videoTracks[t];
    if (track.isMuted()) continue;
    for (var c = 0; c < track.clips.numItems; c++) {
      var clip = track.clips[c];
      if (clip.disabled || time < clip.start.seconds || time >= clip.end.seconds) continue;
      var speed = 1;
      try { speed = Math.abs(clip.getSpeed()) || 1; } catch (e1) {}
      var inner = clip.inPoint.seconds + (time - clip.start.seconds) * speed;
      var item = clip.projectItem;
      if (bc_isSequenceItem(item)) {
        if (depth > 6) continue;
        var nested = bc_sequenceForItem(item);
        var found = nested ? bc_videoAt(nested, inner, depth + 1) : null;
        if (found) return found;
        continue;
      }
      var path = "";
      try { path = item.getMediaPath(); } catch (e2) {}
      if (path) return { path: path, sourceTime: inner, name: clip.name };
    }
  }
  return null;
}

function bc_getFrameSource() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return bc_json({ success: false, error: "Open a sequence first." });
    var time = seq.getPlayerPosition().seconds;
    var found = bc_videoAt(seq, time, 0);
    if (!found) return bc_json({ success: false, error: "There's no video clip under the playhead. Move the playhead over a clip." });
    found.success = true;
    found.playhead = time;
    return bc_json(found);
  } catch (e) {
    return bc_error(e);
  }
}

// Saves the Program monitor frame (with effects) as a PNG via the QE DOM.
function bc_exportProgramFrame(outPath) {
  try {
    app.enableQE();
    var q = qe.project.getActiveSequence();
    if (!q) return bc_json({ success: false, error: "Open a sequence first." });
    q.exportFramePNG(q.CTI.timecode, outPath);
    var candidates = [outPath, outPath + ".png"];
    for (var i = 0; i < candidates.length; i++) {
      for (var wait = 0; wait < 40; wait++) {
        if (new File(candidates[i]).exists) return bc_json({ success: true, path: candidates[i] });
        $.sleep(100);
      }
    }
    return bc_json({ success: false, error: "Premiere didn't export the Program frame. Use \"Clip at playhead\" instead." });
  } catch (e) {
    return bc_error(e);
  }
}

function bc_findLumetri(clip) {
  for (var k = 0; k < clip.components.numItems; k++) {
    var comp = clip.components[k];
    if (comp.matchName === "AE.ADBE Lumetri" || comp.displayName === "Lumetri Color") return comp;
  }
  return null;
}

// Adds Lumetri Color to each selected video clip (if it has none) and tries to
// set its Look to `lutPath`. Setting the Look isn't officially supported by
// Premiere's scripting, so the result says whether it actually took.
function bc_applyLutToSelection(lutPath) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return bc_json({ success: false, error: "Open a sequence first." });
    var selection = seq.getSelection() || [];
    var videos = [];
    for (var i = 0; i < selection.length; i++) if (selection[i].mediaType === "Video") videos.push(selection[i]);
    if (!videos.length) return bc_json({ success: false, error: "Select one or more video clips in the timeline first." });

    app.enableQE();
    var q = qe.project.getActiveSequence();
    var lumetriEffect = qe.project.getVideoEffectByName("Lumetri Color");
    var fileName = lutPath.substr(Math.max(lutPath.lastIndexOf("/"), lutPath.lastIndexOf("\\")) + 1);
    var added = 0;
    var lookSet = 0;

    for (var v = 0; v < videos.length; v++) {
      var clip = videos[v];
      if (!bc_findLumetri(clip) && lumetriEffect) {
        // Find the same clip in the QE DOM by track and start time.
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
          var track = seq.videoTracks[t];
          var onTrack = false;
          for (var c = 0; c < track.clips.numItems; c++) if (track.clips[c].nodeId === clip.nodeId) onTrack = true;
          if (!onTrack) continue;
          var qTrack = q.getVideoTrackAt(t);
          for (var n = 0; n < qTrack.numItems; n++) {
            var qItem = qTrack.getItemAt(n);
            if (qItem && qItem.type !== "Empty" && Math.abs(qItem.start.secs - clip.start.seconds) < 0.01) {
              qItem.addVideoEffect(lumetriEffect);
              added++;
              break;
            }
          }
        }
      }
      var lumetri = bc_findLumetri(clip);
      if (!lumetri) continue;
      for (var p = 0; p < lumetri.properties.numItems; p++) {
        var prop = lumetri.properties[p];
        if (prop.displayName !== "Look") continue;
        try {
          prop.setValue(lutPath, true);
          var now = String(prop.getValue());
          if (now.indexOf(fileName) !== -1) lookSet++;
        } catch (eSet) {}
        break;
      }
    }
    return bc_json({ success: true, clips: videos.length, lumetriAdded: added, lookSet: lookSet });
  } catch (e) {
    return bc_error(e);
  }
}
