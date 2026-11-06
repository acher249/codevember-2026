// A dropped connection on a phone should not end the visit. Asks again a few times, waiting a little longer each time.
export async function withRetries<T>(load: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await load();
    } catch (failure) {
      if (attempt >= attempts) throw failure;
      await new Promise((resolve) => window.setTimeout(resolve, 500 * attempt));
    }
  }
}
