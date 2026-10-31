from reeval_python import evaluate
from reeval_python.aio import expect


@evaluate("stay-within")
async def stay_within(c):
    turn = await c.send("Write greet.js exporting greet(name).")
    await expect(turn).to_stay_within(tool_calls=1, duration="5m")
    await expect(c).to_stay_within(tokens=10)
