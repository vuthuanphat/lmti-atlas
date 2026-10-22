import io
import json
import unittest
from unittest.mock import Mock

from lmti_topology import Grant, TopologyError
from lmti_topology.mcp import MAX_LINE, Server

class BoundaryTest(unittest.TestCase):
    def ready(self, server):
        response = server.dispatch({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}})
        self.assertEqual(response["result"]["protocolVersion"], "2025-06-18")
        self.assertIsNone(server.dispatch({"jsonrpc": "2.0", "method": "notifications/initialized"}))

    def test_grant_and_initialization(self):
        for site in ("../site", "", "a;command", "a\n"):
            with self.assertRaises(TopologyError):
                Grant(site)
        server = Server(Mock())
        self.assertIn("error", server.dispatch({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        self.ready(server)
        response = server.dispatch({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual(len(response["result"]["tools"]), 3)

    def test_tool_cannot_change_grant(self):
        client = Mock()
        server = Server(client)
        self.ready(server)
        for arguments in ({"site": "another-site"}, {"target": "local"}, {"database": "another.sqlite"}, {"role": "admin"}):
            result = server.dispatch({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "topology_context", "arguments": arguments}})
            self.assertTrue(result["result"]["isError"])
        client.context.assert_not_called()
        result = server.dispatch({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "execute_shell", "arguments": {}}})
        self.assertIn("error", result)
        for invalid_name in (None, [], {}, 7):
            response = server.dispatch({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": invalid_name}})
            self.assertEqual(response["error"]["code"], -32602)

    def test_stream_limits_and_parse_errors(self):
        server = Server(Mock())
        reader = io.BytesIO(b"{" + b" " * MAX_LINE + b"}\ninvalid-json\n" + b'{"jsonrpc":"2.0","id":4,"method":"ping"}\n')
        writer = io.BytesIO()
        server.serve(reader, writer)
        messages = [json.loads(line) for line in writer.getvalue().splitlines()]
        self.assertEqual(len(messages), 3)
        self.assertEqual(messages[0]["error"]["code"], -32600)
        self.assertEqual(messages[1]["error"]["code"], -32700)
        self.assertEqual(messages[2]["result"], {})
        duplicate_keys = io.BytesIO(b'{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}\n')
        output = io.BytesIO()
        server.serve(duplicate_keys, output)
        self.assertEqual(json.loads(output.getvalue())["error"]["code"], -32700)

if __name__ == "__main__":
    unittest.main()
