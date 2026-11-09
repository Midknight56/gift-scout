"""Small checks for the film cutter's timeline and plan rules."""
from film_cut import build_timeline, check_length, has_forbidden_dash, has_banned_words, place_voice, source_to_film, validate_captions


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
    raises(lambda: place_voice({"lines": [{"id": "c", "beat": "start", "offset": 0, "take": 1, "text": "A sandbox payment."}]}, beats, segments, {"c": 1.0}, length), "voice line with sandbox")
    print("PASS voice placement")

    check_length(170.0, [165, 175])
    raises(lambda: check_length(180.0, [165, 175]), "film length")
    print("PASS length check")
    print("ALL CASES OK")


if __name__ == "__main__":
    main()
