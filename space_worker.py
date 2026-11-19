"""space_worker.py - works out satellite passes in its own process, at low priority, so the radio's thread never waits
for it. Reads the arguments of space.compute_passes as JSON on stdin and writes the passes as JSON on stdout."""
import json
import os
import sys

if __name__ == "__main__":
    try:
        os.nice(10)
    except (OSError, AttributeError):
        pass
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import space
    args = json.loads(sys.stdin.read())
    json.dump(space.compute_passes(*args), sys.stdout)
