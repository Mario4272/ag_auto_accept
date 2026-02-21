export class Mutex {
    private queue: Promise<void> = Promise.resolve();

    public async dispatch<T>(fn: () => Promise<T> | T): Promise<T> {
        // Append the task to the queue
        const result = this.queue.then(() => fn());

        // Update the queue to wait for this task (handling errors so queue doesn't break)
        this.queue = result.then(() => { }, () => { });

        return result;
    }
}
