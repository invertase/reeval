function toFahrenheit(celsius) {
  return (celsius * 9) / 5 + 32
}

function toCelsius(fahrenheit) {
  return ((fahrenheit - 32) * 5) / 9
}

module.exports = { toCelsius, toFahrenheit }
