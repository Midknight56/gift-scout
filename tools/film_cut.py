"""Cut the Gift Scout tour into a captioned film."""
import copy
import json
import math
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "out" / "film"
VOICE_DIR = ROOT / "out" / "film" / "voice"
SRC = OUT_DIR / "tour.mp4"
BEATS_FILE = OUT_DIR / "tour-beats.json"
PLAN_FILE = ROOT / "docs" / "film-plan.json"
OUT = OUT_DIR / "gift-scout-film.mp4"
FPS = 30
RATE = 48000
FONT = "C\\:/Windows/Fonts/seguisb.ttf"
BANNED_WORDS = (
    "sandbox", "test money", "test card", "fake", "pretend", "for this demo",
    "synthetic", "scripted", "not real money", "simulated money", "play money",
    "demo cap", "fictional",
)
BANNED_RAW = (r"simulat\w*", r"samples?")
BANNED_PATTERN = re.compile(
    r"\b(?:"
    + "|".join([re.escape(w).replace(r"\ ", r"\s+") for w in BANNED_WORDS] + list(BANNED_RAW))
    + r")\b",
    re.IGNORECASE,
)


def has_forbidden_dash(text):
    return bool(re.search(r"\w[-\u2013\u2014]\w|[\u2013\u2014]", text))


def has_banned_words(text):
    return bool(text and BANNED_PATTERN.search(str(text)))


def resolve_time(value, beats):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if value not in beats:
        raise ValueError(f"Unknown beat: {value}")
    return float(beats[value]["at"])


def build_timeline(plan, beats):
    segments = []
    film_start = 0.0
    for item in plan["segments"]:
        source_from = resolve_time(item["from"], beats)
        source_to = resolve_time(item["to"], beats)
        speed = float(item.get("speed", 1.0))
        pad = float(item.get("pad_after", 0.0))
        if source_to <= source_from or speed <= 0 or pad < 0:
            raise ValueError("Segment times, speed, or pad are invalid")
        duration = (source_to - source_from) / speed
        segments.append({"from": source_from, "to": source_to, "speed": speed,
                         "pad": pad, "start": film_start, "duration": duration})
        film_start += duration + pad
    end_hold = float(plan.get("end_hold", 0.0))
    if end_hold < 0:
        raise ValueError("End hold must not be negative")
    return segments, film_start + end_hold


def source_to_film(source_time, segments):
    for segment in segments:
        if segment["from"] <= source_time <= segment["to"]:
            return segment["start"] + (source_time - segment["from"]) / segment["speed"]
    return None


def validate_captions(captions, film_length):
    ordered = sorted(captions, key=lambda cue: cue["start"])
    for cue in ordered:
        if cue["end"] <= cue["start"]:
            raise ValueError("Caption length must be positive")
        if has_forbidden_dash(cue["text"]):
            raise ValueError(f"Caption contains a dash: {cue['text']}")
        if has_banned_words(cue["text"]):
            raise ValueError(f"Caption contains a banned word: {cue['text']}")
        if len(cue["text"]) > 70:
            raise ValueError(f"Caption exceeds 70 characters: {cue['text']}")
        if cue["end"] > film_length:
            raise ValueError(f"Caption ends past the film: {cue['text']}")
    for previous, current in zip(ordered, ordered[1:]):
        if current["start"] < previous["end"]:
            raise ValueError("Captions overlap on the film clock")
    return ordered


def place_voice(script, beats, segments, durations, film_length):
    placed = []
    lines = script.get("lines", []) if isinstance(script, dict) else script
    for line in lines:
        ident = line["id"]
        beat = line.get("beat")
        if beat not in beats:
            raise ValueError(f"Unknown beat: {beat}")
        start = source_to_film(float(beats[beat]["at"]), segments)
        if start is None:
            raise ValueError(f"Beat outside segments: {beat}")
        if ident not in durations or durations[ident] is None:
            raise ValueError(f"Missing duration for line: {ident}")
        duration = float(durations[ident])
        text = str(line.get("text", ""))
        if has_forbidden_dash(text):
            raise ValueError(f"Voice line contains a dash: {text}")
        if has_banned_words(text):
            raise ValueError(f"Voice line contains a banned word: {text}")
        at = round(start + float(line.get("offset", 0.0)), 3)
        end = round(at + duration, 3)
        entry = dict(line)
        entry["at"] = at
        entry["end"] = end
        placed.append(entry)
    placed.sort(key=lambda item: item["at"])
    for line in placed:
        if line["end"] > film_length:
            raise ValueError(f"Voice line ends past the film: {line['id']}")
    for previous, current in zip(placed, placed[1:]):
        if previous["end"] > current["at"]:
            raise ValueError(f"Voice line {previous['id']} overlaps {current['id']}")
    return placed


def auto_fit(plan, beats, script, durations, gap=0.3):
    plan_copy = copy.deepcopy(plan)
    script_copy = copy.deepcopy(script)
    lines = script_copy.get("lines", []) if isinstance(script_copy, dict) else script_copy
    if not lines:
        return plan_copy

    def calc_placed(item_lines, cur_segments):
        placed_list = []
        for line in item_lines:
            ident = line["id"]
            beat = line.get("beat")
            if beat not in beats:
                raise ValueError(f"Unknown beat: {beat}")
            start = source_to_film(float(beats[beat]["at"]), cur_segments)
            if start is None:
                raise ValueError(f"Beat outside segments: {beat}")
            if ident not in durations or durations[ident] is None:
                raise ValueError(f"Missing duration for line: {ident}")
            duration = float(durations[ident])
            at = round(start + float(line.get("offset", 0.0)), 3)
            end = round(at + duration, 3)
            placed_list.append({
                "line": line,
                "id": ident,
                "beat": beat,
                "anchor": float(beats[beat]["at"]),
                "at": at,
                "end": end,
                "duration": duration,
            })
        return placed_list

    segments, film_length = build_timeline(plan_copy, beats)
    initial_placed = calc_placed(lines, segments)
    initial_placed.sort(key=lambda x: (x["at"], lines.index(x["line"])))
    ordered_lines = [item["line"] for item in initial_placed]

    script_modified = False
    holds = []

    for i in range(1, len(ordered_lines)):
        segments, film_length = build_timeline(plan_copy, beats)
        placed = calc_placed(ordered_lines, segments)
        prev = placed[i - 1]
        curr = placed[i]
        diff = round(prev["end"] + gap - curr["at"], 3)
        if diff > 0:
            need = diff
            prev_anchor = prev["anchor"]
            curr_anchor = curr["anchor"]
            if curr_anchor == prev_anchor:
                curr_line = curr["line"]
                curr_line["offset"] = round(float(curr_line.get("offset", 0.0)) + need, 3)
                script_modified = True
            else:
                LEAD = 0.2
                search_point = curr_anchor - 0.001
                target_idx = None
                for idx, seg in enumerate(plan_copy["segments"]):
                    s_from = resolve_time(seg["from"], beats)
                    s_to = resolve_time(seg["to"], beats)
                    if s_from <= search_point <= s_to:
                        target_idx = idx
                        break
                if target_idx is None:
                    for idx, seg in enumerate(plan_copy["segments"]):
                        s_from = resolve_time(seg["from"], beats)
                        s_to = resolve_time(seg["to"], beats)
                        if s_from <= curr_anchor <= s_to:
                            target_idx = idx
                            break
                if target_idx is None:
                    raise ValueError(f"No segment contains anchor {curr_anchor}")
                seg = plan_copy["segments"][target_idx]
                speed = float(seg.get("speed", 1.0))
                s_from = resolve_time(seg["from"], beats)
                split_point = round(curr_anchor - LEAD * speed, 4)
                if split_point > s_from + 0.1 * speed:
                    first = {
                        "from": seg["from"],
                        "to": split_point,
                        "speed": speed,
                        "pad_after": float(need),
                    }
                    second = {
                        "from": split_point,
                        "to": seg["to"],
                        "speed": speed,
                        "pad_after": float(seg.get("pad_after", 0.0)),
                    }
                    plan_copy["segments"][target_idx:target_idx + 1] = [first, second]
                else:
                    if target_idx == 0:
                        raise ValueError("Segment too short to split and no previous segment")
                    prev_seg = plan_copy["segments"][target_idx - 1]
                    prev_seg["pad_after"] = float(prev_seg.get("pad_after", 0.0)) + need
                holds.append({"seconds": need, "line": curr["id"]})

    segments, film_length = build_timeline(plan_copy, beats)
    placed = calc_placed(ordered_lines, segments)
    last_end = placed[-1]["end"]
    if last_end > film_length - 0.5:
        diff = round(last_end - (film_length - 0.5), 3)
        plan_copy["end_hold"] = float(plan_copy.get("end_hold", 0.0)) + diff

    if script_modified:
        plan_copy["script"] = script_copy
    plan_copy["holds"] = holds
    return plan_copy


def check_length(length, target):
    if not float(target[0]) <= length <= float(target[1]):
        raise ValueError(f"Film length {length:.2f} s is outside target {target}")


def make_captions(plan, beats, segments, film_length):
    cues = []
    for item in plan["captions"]:
        name = item["beat"]
        if name not in beats:
            raise ValueError(f"Caption names unknown beat: {name}")
        start = source_to_film(float(beats[name]["at"]), segments)
        if start is None:
            raise ValueError(f"Caption beat is outside the selected segments: {name}")
        start += float(item.get("offset", 0.0))
        cues.append({"text": str(item["text"]), "start": start,
                     "end": start + float(item["length"])})
    cues.sort(key=lambda cue: cue["start"])
    for i in range(1, len(cues)):
        prev_end = cues[i - 1]["end"]
        if cues[i]["start"] < prev_end + 0.15:
            length = cues[i]["end"] - cues[i]["start"]
            cues[i]["start"] = prev_end + 0.15
            cues[i]["end"] = cues[i]["start"] + length
    return validate_captions(cues, film_length)


def make_music(path, length, click_times):
    import numpy as np

    count = int(length * RATE)
    t = np.arange(count, dtype=np.float64) / RATE
    left = np.zeros(count)
    right = np.zeros(count)
    rng = np.random.default_rng(23)
    beat = 60.0 / 92.0
    bar = beat * 4
    chords = ((50, 54, 57), (57, 61, 64), (62, 66, 69), (57, 61, 64))

    def hz(midi):
        return 440.0 * 2 ** ((midi - 69) / 12)

    def put(signal, at, gain, pan=0.0):
        start = int(at * RATE)
        end = min(count, start + len(signal))
        if start < count and end > start:
            left[start:end] += signal[:end-start] * gain * math.cos((pan + 1) * math.pi / 4)
            right[start:end] += signal[:end-start] * gain * math.sin((pan + 1) * math.pi / 4)

    bars = math.ceil(length / bar)
    for index in range(bars):
        at = index * bar
        stop = min(length, at + bar + 0.8)
        ix = np.arange(int(at * RATE), min(count, int(stop * RATE)))
        local = ix / RATE - at
        chord = chords[index % len(chords)]
        pad = sum(np.sin(2*np.pi*hz(note+12)*local) + 0.4*np.sin(2*np.pi*hz(note+24)*local)
                  for note in chord) / (len(chord) * 1.4)
        env = np.minimum(1, local / 0.8) * np.minimum(1, np.maximum(0, (length - (ix / RATE)) / 2))
        left[ix] += pad * env * 0.035
        right[ix] += pad * env * 0.035
        if at >= 2:
            bass_len = min(bar, length - at)
            bt = np.arange(int(bass_len * RATE)) / RATE
            tone = (np.sin(2*np.pi*hz(chord[0]-12)*bt) + 0.16*np.sin(4*np.pi*hz(chord[0]-12)*bt)) * np.exp(-bt*1.7)
            put(tone, at, 0.13)
            if at + 2*beat < length:
                put(tone[:int(min(len(tone)/RATE, beat)*RATE)], at + 2*beat, 0.07)
        for step in range(8):
            note_at = at + step * beat / 2
            if note_at >= length - 2 or step in (3, 7) and index % 2:
                continue
            duration = min(0.9, length - note_at)
            bt = np.arange(int(duration * RATE)) / RATE
            note = chord[(step + index) % 3] + 24
            bell = (np.sin(2*np.pi*hz(note)*bt) + 0.22*np.sin(2*np.pi*hz(note)*2.7*bt)*np.exp(-bt*5)) * np.exp(-bt*2.6)
            put(bell, note_at, 0.025, -0.3 if step % 2 else 0.3)
            if step % 2 == 1 and note_at > 8:
                n = int(0.055 * RATE)
                noise = np.diff(rng.standard_normal(n), prepend=0) * np.exp(-np.arange(n)/RATE*48)
                put(noise, note_at, 0.008, 0.2)
    for at in click_times:
        n = int(0.025 * RATE)
        tt = np.arange(n) / RATE
        noise = rng.standard_normal(n)
        filtered = np.diff(noise, prepend=0) * np.exp(-tt * 150)
        put(filtered, at, 0.055)
    fade_in = np.minimum(1.0, t / 2.0)
    fade_out = np.minimum(1.0, np.maximum(0.0, (length - t) / 3.0))
    stereo = np.stack((left, right), axis=1) * (fade_in * fade_out)[:, None]
    peak = np.max(np.abs(stereo))
    if peak:
        stereo *= 0.82 / peak
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes((stereo * 32767).astype("<i2").tobytes())


def resolve_dir():
    args = sys.argv[1:]
    if "--dir" in args:
        idx = args.index("--dir")
        if idx + 1 < len(args):
            folder = Path(args[idx + 1])
            return folder if folder.is_absolute() else ROOT / folder
    return ROOT / "out" / "film"


def run():
    out_dir = resolve_dir()
    source = out_dir / "tour.mp4" if (out_dir / "tour.mp4").exists() else out_dir / "take.mp4"
    beats_path = out_dir / "tour-beats.json" if (out_dir / "tour-beats.json").exists() else out_dir / "beats.json"
    out_film = out_dir / "gift-scout-film.mp4"
    for path in (source, beats_path, PLAN_FILE):
        if not path.is_file():
            raise SystemExit(f"Required input is missing: {path}")
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("ffmpeg and ffprobe must be available on PATH")
    plan = json.loads(PLAN_FILE.read_text(encoding="utf-8"))
    beat_doc = json.loads(beats_path.read_text(encoding="utf-8"))
    beat_rows = beat_doc.get("beats", beat_doc) if isinstance(beat_doc, dict) else beat_doc
    beats = {row["name"]: row for row in beat_rows}
    if len(beats) != len(beat_rows):
        raise SystemExit("Beat names must be unique")
    if any(row.get("failed") or row.get("name") == "failed" for row in beat_rows):
        raise SystemExit("The beats file contains a failed beat")
    for segment in plan["segments"]:
        for endpoint in (segment["from"], segment["to"]):
            if isinstance(endpoint, str) and endpoint not in beats:
                raise SystemExit(f"Plan names unknown beat: {endpoint}")
    voice_script_file = ROOT / "docs" / "voice-script.json"
    durations = {}
    script = None
    if voice_script_file.is_file():
        script = json.loads(voice_script_file.read_text(encoding="utf-8-sig"))
        for line in script.get("lines", []):
            ident, take = line["id"], line["take"]
            take_path = VOICE_DIR / f"{ident}-take{take}.mp3"
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(take_path)],
                capture_output=True, text=True,
            )
            if probe.returncode == 0 and probe.stdout.strip():
                try:
                    durations[ident] = float(probe.stdout.strip())
                except ValueError:
                    pass
        plan = auto_fit(plan, beats, script, durations)
        for hold in plan.get("holds", []):
            print(f"hold {hold['seconds']:.2f} s before {hold['line']}")
        (out_dir / "film-plan-fitted.json").write_text(
            json.dumps(plan, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        if "script" in plan:
            script = plan["script"]
    segments, length = build_timeline(plan, beats)
    target = plan["target"]
    check_length(length, target)
    captions = make_captions(plan, beats, segments, length)
    out_dir.mkdir(parents=True, exist_ok=True)
    caption_dir = out_dir / "captions"
    caption_dir.mkdir(exist_ok=True)
    for old in caption_dir.glob("*.txt"):
        old.unlink()
    graph = []
    labels = []
    for i, segment in enumerate(segments):
        a, b, speed = segment["from"], segment["to"], segment["speed"]
        graph.append(f"[0:v]trim=start={a:.4f}:end={b:.4f},setpts=(PTS-STARTPTS)/{speed:.8f},fps={FPS},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v{i}]")
        labels.append(f"[v{i}]")
        if segment["pad"]:
            graph.append(f"[v{i}]tpad=stop_mode=clone:stop_duration={segment['pad']:.4f}[p{i}]")
            labels[-1] = f"[p{i}]"
    graph.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0[cat]")
    if plan.get("end_hold", 0):
        graph.append(f"[cat]tpad=stop_mode=clone:stop_duration={float(plan['end_hold']):.4f}[held]")
        chain = "[held]"
    else:
        chain = "[cat]"
    for i, cue in enumerate(captions):
        txt = caption_dir / f"c{i:02d}.txt"
        txt.write_text(cue["text"], encoding="utf-8")
        graph.append(chain + f"drawtext=fontfile='{FONT}':textfile='captions/{txt.name}':fontsize=44:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=18:x=(w-text_w)/2:y=h-text_h-70:alpha='if(lt(t,{cue['start']:.3f}+0.25),(t-{cue['start']:.3f})/0.25,if(gt(t,{cue['end']:.3f}-0.25),({cue['end']:.3f}-t)/0.25,1))':enable='between(t,{cue['start']:.3f},{cue['end']:.3f})'[cap{i}]")
        chain = f"[cap{i}]"
    fade_start = max(0.0, length - 1.0)
    graph.append(chain + f"fade=t=in:st=0:d=0.6,fade=t=out:st={fade_start:.3f}:d=1,format=yuv420p[vout]")
    graph_file = out_dir / "film-graph.txt"
    graph_file.write_text(";\n".join(graph), encoding="utf-8")
    music = out_dir / "music.wav"
    click_times = []
    for row in beat_rows:
        if row.get("click") is True:
            mapped = source_to_film(float(row["at"]), segments)
            if mapped is not None:
                click_times.append(mapped)
    make_music(music, length, click_times)
    audio = music
    if script is not None:
        placed = place_voice(script, beats, segments, durations, length)
        (out_dir / "voice-placed.json").write_text(
            json.dumps(placed, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        mix = out_dir / "mix.wav"
        if placed:
            inputs = ["-i", str(music)]
            delays = []
            for i, line in enumerate(placed):
                take_file = VOICE_DIR / f"{line['id']}-take{line['take']}.mp3"
                inputs.extend(["-i", str(take_file)])
                delay_ms = int(round(line["at"] * 1000))
                delays.append(f"[{i + 1}:a]aresample={RATE},aformat=channel_layouts=stereo,adelay={delay_ms}:all=1[v{i}]")
            labels = "".join(f"[v{i}]" for i in range(len(placed)))
            graph_parts = list(delays)
            graph_parts.append(f"{labels}amix=inputs={len(placed)}:normalize=0,apad=whole_dur={length:.3f}[voice]")
            graph_parts.append("[voice]asplit=2[voice_audible][voice_sc]")
            graph_parts.append("[0:a][voice_sc]sidechaincompress=threshold=0.02:ratio=6:attack=15:release=350[ducked]")
            graph_parts.append("[ducked][voice_audible]amix=inputs=2:normalize=0:weights='1 1.6'[mix]")
            mix_cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + inputs + [
                "-filter_complex", ";".join(graph_parts), "-map", "[mix]",
                "-c:a", "pcm_s16le", "-ar", str(RATE), "-t", f"{length:.3f}", str(mix)
            ]
            subprocess.run(mix_cmd, cwd=out_dir, check=True)
            audio = mix
        else:
            shutil.copyfile(music, mix)
            audio = mix
    base_cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-i", str(audio),
                "-filter_complex_script", graph_file.name, "-map", "[vout]", "-map", "1:a",
                "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS),
                "-c:a", "aac", "-b:a", "192k", "-ar", str(RATE), "-t", f"{length:.3f}", "-movflags", "+faststart"]
    # The audio track is mix.wav when voice is present or music.wav alone, measured directly in the first pass.
    analysis = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(audio), "-t", f"{length:.3f}", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], cwd=out_dir, capture_output=True, text=True)
    if analysis.returncode:
        raise SystemExit(analysis.stderr.strip())
    match = re.search(r"\{\s*\"input_i\".*?\}", analysis.stderr, re.S)
    if not match:
        raise SystemExit("Could not read first pass loudness measurements: " + analysis.stderr[-1500:])
    stats = json.loads(match.group())
    measured = f"measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:offset={stats['target_offset']}:linear=true"
    subprocess.run(base_cmd + ["-af", f"loudnorm=I=-16:TP=-1.5:LRA=11:{measured}:print_format=summary", str(out_film)], cwd=out_dir, check=True)
    duration_probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out_film)], capture_output=True, text=True, check=True)
    encoded_length = float(duration_probe.stdout.strip())
    check_length(encoded_length, target)
    probe = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(out_film), "-filter_complex", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"], capture_output=True, text=True, check=True)
    loudness = re.search(r"Integrated loudness:\s*I:\s*([^\n]+).*?True peak:\s*Peak:\s*([^\n]+)", probe.stderr, re.S)
    if loudness:
        print(f"Integrated loudness: {loudness.group(1).strip()} LUFS; true peak: {loudness.group(2).strip()} dBFS")
    cut_data = {"length": encoded_length, "captions": [{"number": i + 1, "text": c["text"], "start": round(c["start"], 3), "end": round(c["end"], 3)} for i, c in enumerate(captions)]}
    (out_dir / "film-cut.json").write_text(json.dumps(cut_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    contact_sheet(captions, out_dir, out_film)
    print(f"film: {out_film} {encoded_length:.2f} s {len(captions)} captions")


def contact_sheet(captions, out_dir=None, out_film=None):
    if out_dir is None:
        out_dir = resolve_dir()
    if out_film is None:
        out_film = out_dir / "gift-scout-film.mp4"
    if not captions:
        raise SystemExit("The plan has no captions for a contact sheet")
    from PIL import Image, ImageDraw, ImageFont

    tile_w, tile_h, label_h, cols = 640, 360, 34, 4
    rows = math.ceil(len(captions) / cols)
    sheet = Image.new("RGB", (cols * tile_w, rows * (tile_h + label_h)), "white")
    font = ImageFont.truetype("C:/Windows/Fonts/seguisb.ttf", 18)
    frames_dir = out_dir / "sheet-frames"
    frames_dir.mkdir(exist_ok=True)
    for i, cue in enumerate(captions):
        at = (cue["start"] + cue["end"]) / 2
        frame = frames_dir / f"{i + 1:02d}.png"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{at:.3f}", "-i", str(out_film),
                        "-frames:v", "1", "-vf", f"scale={tile_w}:{tile_h}", str(frame)], cwd=out_dir, check=True)
        x, y = (i % cols) * tile_w, (i // cols) * (tile_h + label_h)
        with Image.open(frame) as picture:
            sheet.paste(picture.convert("RGB"), (x, y))
        ImageDraw.Draw(sheet).text((x + 10, y + tile_h + 6), f"{i + 1}  {int(at) // 60}:{int(at) % 60:02d}", fill="black", font=font)
    sheet.save(out_dir / "contact-sheet.jpg", quality=90)
    shutil.rmtree(frames_dir)


if __name__ == "__main__":
    try:
        run()
    except (ValueError, KeyError, json.JSONDecodeError) as error:
        raise SystemExit(str(error))
