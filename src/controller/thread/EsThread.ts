import { assertMessageEvent,
    ControllerJobRunMessage,
    ControllerMessageType,
    ControllerTerminateMessage,
    isWorkerInitMessage,
    isWorkerJobErrorMessage,
    isWorkerJobResultMessage,
    isWorkerUncaughtErrorMessage,
    WorkerInitMessage,
    TaskUID } from "../../shared/Messages";
import { Terminable, WorkerModule } from "../../shared/Worker";
import { isTransferDescriptor, TransferDescriptor } from "../../shared/TransferDescriptor";
import { getRandomUID } from "../../shared/Utils";
import { EsTaskPromise } from "./EsTask";

type StripTransfer<Type> =
    Type extends TransferDescriptor<infer BaseType>
    ? BaseType
    : Type

type ProxyableFunction<Args extends any[], ReturnType> =
    Args extends []
    ? () => Promise<StripTransfer<Awaited<ReturnType>>>
    : (...args: Args) => Promise<StripTransfer<Awaited<ReturnType>>>

type ModuleMethods = { [methodName: string]: (...args: any) => any }

type ModuleProxy<Methods extends ModuleMethods> = {
    [method in keyof Methods]: ProxyableFunction<Parameters<Methods[method]>, ReturnType<Methods[method]>>
}

type WorkerType = Worker | SharedWorker;

interface WorkerInterface {
    postMessage(message: any, transfer: Transferable[]): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

export class EsThread<ApiType extends WorkerModule<any>> implements Terminable {
    readonly tasks: Map<TaskUID, EsTaskPromise<any>> = new Map();
    readonly threadUID = getRandomUID();

    private worker: WorkerType;
    private interface: WorkerInterface;

    public methods: ModuleProxy<ApiType> = {} as ModuleProxy<ApiType>;
    public get numQueuedJobs() { return this.tasks.size; }

    private constructor(worker: WorkerType) {
        this.worker = worker;
        if(worker instanceof Worker) this.interface = worker;
        else {
            this.interface = worker.port;
            worker.port.start();
        }
    }

    public static async Spawn<ApiType extends WorkerModule<any>>(worker: WorkerType) {
        const thread = new EsThread<ApiType>(worker);
        return thread.initThread();
    }

    public async settled(): Promise<void> {
        await Promise.allSettled(this.tasks.values());
    }

    public async terminate(): Promise<void> {
        // Don't terminate until all tasks are done.
        await this.settled();

        // Send terminate message to worker.
        const terminateMessage: ControllerTerminateMessage = {
            type: ControllerMessageType.Terminate };
        this.interface.postMessage(terminateMessage, []);

        this.interface.removeEventListener("message", this.taskResultDispatch);

        if(this.worker instanceof Worker) this.worker.terminate();
    }

    private taskResultDispatch = (evt: Event) => {
        try {
            assertMessageEvent(evt);

            if(isWorkerJobResultMessage(evt.data)) {
                const task = this.tasks.get(evt.data.uid);
                if(!task) throw new Error("Recived result for invalid task with UID " + evt.data.uid);
                this.tasks.delete(task.taskUID);
                task.resolve(evt.data.result);
            }
            else if(isWorkerJobErrorMessage(evt.data)) {
                const task = this.tasks.get(evt.data.uid);
                if(!task) throw new Error("Recived error for invalid task with UID " + evt.data.uid);
                this.tasks.delete(task.taskUID);
                task.reject(new Error(evt.data.errorMessage));
            }
            else if(isWorkerUncaughtErrorMessage(evt.data)) {
                throw new Error("Uncaught error in worker: " + evt.data.errorMessage);
            }

            // TODO: handle other event types?
        }
        catch(e) {
            console.error(e);
        }
    }

    private static prepareArguments(rawArgs: any[]): {args: any[], transferables: Transferable[]} {
        const args: any[] = [];
        const transferables: Transferable[] = [];
        for(const arg of rawArgs) {
            if(isTransferDescriptor(arg)) {
                transferables.push(...arg.transferables)
                args.push(arg);
            }
            else {
                args.push(arg);
            }
        }
    
        return {args: args, transferables: transferables}
    }

    private createProxyFunction<Args extends any[], ReturnType>(method: string) {
        return ((...rawArgs: Args) => {
            const taskPromise = EsTaskPromise.Create<ReturnType>();
            const { args, transferables } = EsThread.prepareArguments(rawArgs);
            const runMessage: ControllerJobRunMessage = {
                type: ControllerMessageType.Run,
                uid: taskPromise.taskUID,
                method: method,
                args: args };

            this.interface.postMessage(runMessage, transferables);
            this.tasks.set(taskPromise.taskUID, taskPromise);

            return taskPromise;
        }) as any as ProxyableFunction<Args, ReturnType>
    }

    private createMethodsProxy(
        methodNames: string[])
    {
        const proxy = this.methods as any;
    
        for (const methodName of methodNames) {
            proxy[methodName] = this.createProxyFunction(methodName);
        }
    
        return proxy as ModuleProxy<ApiType>;
    }

    private async initThread() {
        // TODO: have a timeout on this, to make sure a worker failing to init doesn't
        // block execution forever.
        const exposedApi = await new Promise<WorkerInitMessage>((resolve, reject) => {
            const initMessageHandler = (event: Event) => {
                assertMessageEvent(event);
                if (isWorkerInitMessage(event.data)) {
                    this.interface.removeEventListener("message", initMessageHandler);
                    resolve(event.data);
                }
                else if (isWorkerUncaughtErrorMessage(event.data)) {
                    this.interface.removeEventListener("message", initMessageHandler);
                    reject(new Error(event.data.errorMessage));
                }
            };
            this.interface.addEventListener("message", initMessageHandler)
        });

        this.createMethodsProxy(exposedApi.methodNames);

        this.interface.addEventListener("message", this.taskResultDispatch);

        return this;
    }
}