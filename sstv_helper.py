"""sstv_helper.py - decodes a slow-scan TV (SSTV) picture from a sound recording.

Runs as its own program so the GPL-licensed `sstv` package (github.com/colaclanth/sstv) stays separate from Skywave.
Usage: python3 sstv_helper.py input.wav output.png      Prints "MODE <name>" and exits 0 on success, 3 if no picture found.
"""
import os
import sys


def main():
    src, dst = sys.argv[1], sys.argv[2]
    import sstv.common as common
    common.get_terminal_size = lambda: os.terminal_size((100, 24))       # works without a terminal
    from sstv.decode import SSTVDecoder
    with open(src, 'rb') as fh:
        dec = SSTVDecoder(fh)
        img = dec.decode()
    if img is None:
        return 3
    img.save(dst)
    print("MODE %s" % getattr(dec.mode, "NAME", "unknown"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
