"""Small checks for the film cutter's timeline and plan rules."""
from film_cut import build_timeline, check_length, has_forbidden_dash, source_to_film, validate_captions


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

    check_length(170.0, [165, 175])
    raises(lambda: check_length(180.0, [165, 175]), "film length")
    print("PASS length check")
    print("ALL CASES OK")


if __name__ == "__main__":
    main()
