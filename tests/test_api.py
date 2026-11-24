import asyncio
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from loopharbor.main import TaskRequest, submit_task


class TaskSubmissionTests(unittest.TestCase):
    def test_submission_persists_before_queueing(self):
        events = []
        request = TaskRequest(message="Hello")

        with (
            patch(
                "loopharbor.main.create_task",
                side_effect=lambda *args: events.append(("persist", args)),
            ),
            patch(
                "loopharbor.main.execute_agent.apply_async",
                side_effect=lambda **kwargs: events.append(("queue", kwargs)),
            ),
        ):
            accepted = asyncio.run(submit_task(request))

        self.assertEqual([event[0] for event in events], ["persist", "queue"])
        self.assertEqual(accepted.status, "queued")
        self.assertEqual(str(accepted.task_id), events[0][1][0])
        self.assertEqual(str(accepted.conversation_id), events[0][1][1])
        self.assertEqual(events[1][1]["task_id"], str(accepted.task_id))

    def test_only_supported_modes_are_accepted(self):
        with self.assertRaises(ValidationError):
            TaskRequest(message="Hello", mode="unsupported")


if __name__ == "__main__":
    unittest.main()
