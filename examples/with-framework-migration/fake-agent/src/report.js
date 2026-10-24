import { toFahrenheit } from './temperature.js'

export function report(city, celsius) {
  return `${city}: ${celsius}°C (${toFahrenheit(celsius)}°F)`
}
