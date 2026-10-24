"""Fixed local operator launcher; only the trusted API selects its scope."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python" / "src"))
from lmti_agent.operator_read import main

if __name__ == "__main__":
    main()
