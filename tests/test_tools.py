import unittest
from datetime import datetime

from loopharbor.agent import (
    add,
    divide,
    multiply,
    subtract,
    worker_local_datetime,
)


class ArithmeticToolTests(unittest.TestCase):
    def test_four_arithmetic_operations(self):
        self.assertEqual(add.invoke({"a": 7, "b": 3}), 10)
        self.assertEqual(subtract.invoke({"a": 7, "b": 3}), 4)
        self.assertEqual(multiply.invoke({"a": 7, "b": 3}), 21)
        self.assertEqual(divide.invoke({"a": 7, "b": 2}), 3.5)

    def test_division_by_zero_is_rejected(self):
        with self.assertRaises(ValueError):
            divide.invoke({"a": 1, "b": 0})

    def test_worker_datetime_is_iso_formatted(self):
        value = worker_local_datetime.invoke({})
        self.assertEqual(datetime.fromisoformat(value).isoformat(), value)


if __name__ == "__main__":
    unittest.main()
