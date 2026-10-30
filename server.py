"""Command-line entry point. Run python server.py --help."""

from talent_hub.http import handler_class
from talent_hub.runtime import main

__all__ = ["handler_class", "main"]

if __name__ == "__main__":
    main()
