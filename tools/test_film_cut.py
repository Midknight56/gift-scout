"""Small checks for the film cutter's timeline and plan rules."""
from film_cut import auto_fit, build_timeline, make_captions, check_length, has_forbidden_dash, has_banned_words, place_voice, source_to_film, validate_captions


def equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def raises(function, label):
    try:
        function()
    except ValueError:
        return
    raise AssertionError(f"{label}: expected ValueError")


def main():
    beats = {"start": {"at": 2.0}, "middle": {"at": 12.0}, "end": {"at": 22.0}}
    plan = {"segments": [
        {"from": "start", "to": "middle", "speed": 2.0, "pad_after": 1.5},
        {"from": "middle", "to": "end", "speed": 1.0, "pad_after": 0.0},
    ], "end_hold": 2.0}
    segments, length = build_timeline(plan, beats)
    equal(source_to_film(8.0, segments), 3.0, "sped up beat mapping")
    equal(source_to_film(17.0, segments), 11.5, "mapping after pad")
    equal(length, 18.5, "film length with holds")
    print("PASS beat mapping through speed and pad")

    equal(has_forbidden_dash("gift-guide"), True, "word dash")
    equal(has_forbidden_dash("gift\u2013guide"), True, "en dash")
    equal(has_forbidden_dash("gift\u2014guide"), True, "em dash")
    equal(has_forbidden_dash("target -16 LUFS"), False, "minus before number")
    print("PASS dash check")

    raises(lambda: validate_captions([
        {"text": "First", "start": 1.0, "end": 3.0},
        {"text": "Second", "start": 2.9, "end": 4.0},
    ], 10.0), "caption overlap")
    print("PASS overlap check")

    equal(has_banned_words("Pay with the sandbox test card."), True, "sandbox and test card")
    equal(has_banned_words("No real money moves, it is fake."), True, "fake")
    equal(has_banned_words("Just pretend to pay."), True, "pretend")
    equal(has_banned_words("Shown for this demo only."), True, "for this demo")
    equal(has_banned_words("Uses test money."), True, "test money")
    equal(has_banned_words("A simulated payment."), True, "simulated")
    equal(has_banned_words("Simulation only."), True, "simulation")
    equal(has_banned_words("Sample data."), True, "sample")
    equal(has_banned_words("These samples load fast."), True, "samples")
    equal(has_banned_words("Synthetic reviews."), True, "synthetic")
    equal(has_banned_words("A scripted demonstration."), True, "scripted")
    equal(has_banned_words("Not real money."), True, "not real money")
    equal(has_banned_words("Play money only."), True, "play money")
    equal(has_banned_words("The demo cap is reached."), True, "demo cap")
    equal(has_banned_words("A fictional order."), True, "fictional")
    equal(has_banned_words("PayPal captures the payment."), False, "clean line")
    raises(lambda: validate_captions([{"text": "Sandbox checkout.", "start": 1.0, "end": 2.0}], 10.0), "caption with sandbox")
    print("PASS banned words check")

    script = {"lines": [
        {"id": "a", "beat": "start", "offset": 0.5, "take": 1, "text": "One."},
        {"id": "b", "beat": "middle", "offset": 0.0, "take": 1, "text": "Two."},
    ]}
    placed = place_voice(script, beats, segments, {"a": 2.0, "b": 3.0}, length)
    equal([(line["id"], line["at"], line["end"]) for line in placed], [("a", 0.5, 2.5), ("b", 5.0, 8.0)], "voice placed on the film clock")
    raises(lambda: place_voice(script, beats, segments, {"a": 6.5, "b": 3.0}, length), "voice line runs into the next")
    raises(lambda: place_voice(script, beats, segments, {"a": 2.0, "b": 14.0}, length), "voice line runs past the film")
    raises(lambda: place_voice(script, beats, segments, {"a": 2.0}, length), "voice take missing")
    fitted = auto_fit(plan, beats, script, {"a": 6.5, "b": 3.0})
    fitted_segments, fitted_length = build_timeline(fitted, beats)
    fitted_lines = place_voice(script, beats, fitted_segments, {"a": 6.5, "b": 3.0}, fitted_length)
    by_id = {line["id"]: line for line in fitted_lines}
    equal(by_id["b"]["at"] >= by_id["a"]["end"] + 0.3, True, "auto fit holds the frame so b starts after a")
    equal(round(by_id["a"]["at"], 3), 0.5, "auto fit leaves the first line where it was")
    equal(fitted_length > length, True, "auto fit makes the film longer, not faster")
    equal(all((seg["to"] - seg["from"]) / seg["speed"] >= 0.1 for seg in fitted_segments), True, "auto fit leaves no piece too short to hold a frame")
    boundary = auto_fit({"segments": [
        {"from": "start", "to": "middle", "speed": 1.0, "pad_after": 0.0},
        {"from": "middle", "to": "end", "speed": 1.0, "pad_after": 0.0},
    ], "end_hold": 2.0}, beats, script, {"a": 12.0, "b": 3.0})
    boundary_segments, boundary_length = build_timeline(boundary, beats)
    boundary_lines = {line["id"]: line for line in place_voice(script, beats, boundary_segments, {"a": 12.0, "b": 3.0}, boundary_length)}
    equal(boundary_lines["b"]["at"] >= boundary_lines["a"]["end"] + 0.3, True, "a line on a segment boundary lands after its hold")
    equal(all((seg["to"] - seg["from"]) / seg["speed"] >= 0.1 for seg in boundary_segments), True, "no tiny piece at a boundary")
    same = {"lines": [
        {"id": "c", "beat": "start", "offset": 0.5, "take": 1, "text": "One."},
        {"id": "d", "beat": "start", "offset": 1.0, "take": 1, "text": "Two."},
    ]}
    fitted_same = auto_fit(plan, beats, same, {"c": 2.0, "d": 1.0})
    seg_same, len_same = build_timeline(fitted_same, beats)
    placed_same = {line["id"]: line for line in place_voice(fitted_same.get("script", same), beats, seg_same, {"c": 2.0, "d": 1.0}, len_same)}
    equal(placed_same["d"]["at"] >= placed_same["c"]["end"] + 0.3, True, "auto fit spaces two lines on one beat")
    late = {"lines": [{"id": "e", "beat": "end", "offset": 0.0, "take": 1, "text": "Bye."}]}
    fitted_late = auto_fit(plan, beats, late, {"e": 6.0})
    seg_late, len_late = build_timeline(fitted_late, beats)
    placed_late = place_voice(late, beats, seg_late, {"e": 6.0}, len_late)
    equal(placed_late[0]["end"] <= len_late - 0.5, True, "auto fit holds the end until the last line is done")
    # Live take 10 Nov 2026: "sent" at 9.54 s and "first call" at 9.75 s on a 2x piece. The hold for the second line
    # was split in before the first line's beat, so it pushed both lines and they still overlapped.
    fast_beats = {"s": {"at": 0.0}, "p": {"at": 9.54}, "q": {"at": 9.75}, "e": {"at": 40.0}}
    fast_plan = {"segments": [{"from": "s", "to": "e", "speed": 2.0, "pad_after": 0.0}], "end_hold": 2.0}
    fast = {"lines": [
        {"id": "p1", "beat": "p", "offset": 0.2, "take": 1, "text": "One."},
        {"id": "q1", "beat": "q", "offset": 0.3, "take": 1, "text": "Two."},
    ]}
    fitted_fast = auto_fit(fast_plan, fast_beats, fast, {"p1": 4.0, "q1": 3.0})
    seg_fast, len_fast = build_timeline(fitted_fast, fast_beats)
    placed_fast = {line["id"]: line for line in place_voice(fitted_fast.get("script", fast), fast_beats, seg_fast, {"p1": 4.0, "q1": 3.0}, len_fast)}
    equal(placed_fast["q1"]["at"] >= placed_fast["p1"]["end"] + 0.3, True, "a hold between two close beats on a fast piece lands between them")
    close = {"captions": [
        {"beat": "start", "offset": 0.0, "length": 4.0, "text": "First caption."},
        {"beat": "middle", "offset": -4.0, "length": 3.0, "text": "Second caption."},
    ]}
    cues = make_captions(close, beats, segments, length)
    equal(round(cues[1]["start"], 3), round(cues[0]["end"] + 0.15, 3), "a caption that would overlap starts after the one before")
    equal(round(cues[1]["end"] - cues[1]["start"], 3), 3.0, "a pushed caption keeps its length")
    raises(lambda: make_captions({"captions": [{"beat": "end", "offset": 0.0, "length": 30.0, "text": "Too long."}]}, beats, segments, length), "a caption past the film still fails")
    print("PASS voice auto fit")
    raises(lambda: place_voice({"lines": [{"id": "c", "beat": "start", "offset": 0, "take": 1, "text": "A sandbox payment."}]}, beats, segments, {"c": 1.0}, length), "voice line with sandbox")
    print("PASS voice placement")

    check_length(170.0, [165, 175])
    raises(lambda: check_length(180.0, [165, 175]), "film length")
    print("PASS length check")
    print("ALL CASES OK")


if __name__ == "__main__":
    main()
