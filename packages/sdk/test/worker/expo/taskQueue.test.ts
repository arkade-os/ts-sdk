import { InMemoryTaskQueue } from "../../../src/worker/expo/taskQueue";
import { testTaskQueueContract } from "./taskQueue.contract";

testTaskQueueContract("InMemoryTaskQueue", () => new InMemoryTaskQueue());
