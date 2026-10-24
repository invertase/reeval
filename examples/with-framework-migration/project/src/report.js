const { toFahrenheit } = require('./temperature.js')

function report(city, celsius) {
  return `${city}: ${celsius}°C (${toFahrenheit(celsius)}°F)`
}

module.exports = { report }
