/**
 * A single-producer/single-consumer async queue shared by the transports: producers (`data`/`close` listeners, framing pumps) `push`; one consumer pulls via `for await`. Bounded by Node's stream pause on the producer side, not modelled here.
 *
 * @access public
 * @class
 * @module sumo/harness/transport/_queue
 * @template T
 */
export class AsyncQueue {
  /** @type {T[]} */ #items = [];
  /** @type {Array<(r: IteratorResult<T>) => void>} */ #waiters = [];
  #closed = false;

  /**
   * Execute `push`.
   *
   * @access public
   * @param {T} item - Item consumed by `push`.
   * @returns {void} Completes without producing a value.
   */
  push(item) {
    if (this.#closed) return;
    const w = this.#waiters.shift();
    if (w) w({ value: item, done: false });
    else this.#items.push(item);
  }

  /**
   * Close the queue and resolve pending async-iterator waiters.
   *
   * @access public
   * @returns {void} Completes without producing a value.
   */
  close() {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: /** @type {T} */ (undefined), done: true });
  }

  /**
   * Execute `method`.
   *
   * @access public
   * @returns {AsyncIterableIterator<T>} Async iterator returned by this callback.
   */
  [Symbol.asyncIterator]() {
    const self = this;
    return {
      /**
       * Read the next queued item or wait until one is pushed.
       *
       * @access public
       * @returns {Promise<IteratorResult<T>>} Promise that resolves with the shared Result returned by `next`.
       */
      next() {
        if (self.#items.length) return Promise.resolve({ value: /** @type {T} */ (self.#items.shift()), done: false });
        if (self.#closed) return Promise.resolve({ value: /** @type {T} */ (undefined), done: true });
        return new Promise((resolve) => self.#waiters.push(resolve));
      }, /**
       * End iteration without changing the queue's producer-side state.
       *
       * @access public
       * @returns {Promise<IteratorResult<T>>} Promise that resolves with the shared Result returned by `return`.
       */
      return() {
        return Promise.resolve({ value: /** @type {T} */ (undefined), done: true });
      }, /**
       * Async iterators are self-iterable by protocol.
       *
       * @access public
       * @returns {AsyncIterableIterator<T>} Async iterator returned by this callback.
       */
      [Symbol.asyncIterator]() {
        return this;
      }
    };
  }
}
