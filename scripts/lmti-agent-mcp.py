"""Fixed launcher for the existing, scoped LMTI read MCP boundary."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python" / "src"))
from lmti_agent.mcp import main

if __name__ == "__main__":
    main()
