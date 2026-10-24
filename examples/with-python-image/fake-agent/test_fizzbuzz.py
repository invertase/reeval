import unittest

from fizzbuzz import fizzbuzz


class FizzBuzzTest(unittest.TestCase):
    def test_multiples(self):
        self.assertEqual(fizzbuzz(3), "Fizz")
        self.assertEqual(fizzbuzz(5), "Buzz")
        self.assertEqual(fizzbuzz(15), "FizzBuzz")

    def test_other_numbers(self):
        self.assertEqual(fizzbuzz(7), "7")


if __name__ == "__main__":
    unittest.main()
