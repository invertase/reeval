export function toFahrenheit(celsius) {
  return (celsius * 9) / 5 + 32
}

export function toCelsius(fahrenheit) {
  return ((fahrenheit - 32) * 5) / 9
}
