/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module RpcInterface
 */

import { RpcInterface, RpcInterfaceImplementation, RpcInterfaceDefinition } from "../../RpcInterface";
import { RpcInterfaceEndpoints } from "../../RpcManager";
import { RpcOperation, RpcOperationPolicy } from "./RpcOperation";
import { RpcControlChannel } from "./RpcControl";
import { IModelError } from "../../IModelError";
import { BentleyStatus } from "@bentley/bentleyjs-core";
import { RpcConfiguration, RpcPendingQueue, initializeRpcRequest } from "../../imodeljs-common";

// tslint:disable:ban-types

/** @internal */
export const REGISTRY = Symbol.for("@bentley/imodeljs-common/RpcRegistry");

/** @internal */
export const OPERATION = Symbol.for("@bentley/imodeljs-common/RpcOperation");

/** @internal */
export const POLICY = Symbol.for("@bentley/imodeljs-common/RpcOperationPolicy");

/** @internal */
export const INSTANCE = Symbol.for("@bentley/imodeljs-common/RpcInterface/__instance__");

/** @internal */
export const CURRENT_REQUEST = Symbol.for("@bentley/imodeljs-common/RpcRequest/__current__");

/** @internal */
export const CURRENT_INVOCATION = Symbol.for("@bentley/imodeljs-common/RpcInvocation/__current__");

/** @internal */
export class RpcRegistry {
  private static _instance: RpcRegistry;

  private constructor() {
  }

  public static get instance() {
    if (!RpcRegistry._instance) {
      const globalObj: any = typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {};
      if (!globalObj[REGISTRY])
        globalObj[REGISTRY] = new RpcRegistry();

      RpcRegistry._instance = globalObj[REGISTRY];
    }

    return RpcRegistry._instance;
  }

  public lookupInterfaceDefinition(name: string): RpcInterfaceDefinition {
    if (!this.definitionClasses.has(name))
      throw new IModelError(BentleyStatus.ERROR, `RPC interface "${name}" is not initialized.`);

    return this.definitionClasses.get(name) as RpcInterfaceDefinition;
  }

  public async describeAvailableEndpoints(): Promise<RpcInterfaceEndpoints[]> {
    const requests: Array<Promise<RpcInterfaceEndpoints[]>> = [];
    for (const channel of RpcControlChannel.channels) {
      requests.push(channel.describeEndpoints());
    }

    return Promise.all(requests).then((responses) => {
      const endpoints = responses.reduce((a, b) => a.concat(b), []);
      for (const endpoint of endpoints) {
        const definition = this.definitionClasses.get(endpoint.interfaceName);
        endpoint.compatible = (definition && RpcInterface.isVersionCompatible(endpoint.interfaceVersion, definition.interfaceVersion)) ? true : false;
      }

      return endpoints;
    });
  }

  public getClientForInterface<T extends RpcInterface>(definition: RpcInterfaceDefinition<T>): T {
    let instance = this.proxies.get(definition.interfaceName) as (T | undefined);
    if (!instance)
      instance = this.instantiateClient(definition);

    return instance;
  }

  public getImplForInterface<T extends RpcInterface>(definition: RpcInterfaceDefinition<T>): T {
    let instance = this.implementations.get(definition.interfaceName) as (T | undefined);
    if (!instance)
      instance = this.instantiateImpl(definition);

    return instance;
  }

  public lookupImpl<T extends RpcInterface>(interfaceName: string): T {
    const definition = this.lookupInterfaceDefinition(interfaceName);
    return this.getImplForInterface(definition) as T;
  }

  public registerImpl<TDefinition extends RpcInterface, TImplementation extends TDefinition>(definition: RpcInterfaceDefinition<TDefinition>, implementation: RpcInterfaceImplementation<TImplementation>) {
    this.unregisterImpl(definition);
    this.implementationClasses.set(definition.interfaceName, implementation);
  }

  public unregisterImpl<TDefinition extends RpcInterface>(definition: RpcInterfaceDefinition<TDefinition>) {
    this.implementationClasses.delete(definition.interfaceName);

    const impl = this.implementations.get(definition.interfaceName);
    if (impl) {
      impl.configuration.onRpcImplTerminated(definition, impl);
      this.implementations.delete(definition.interfaceName);
    }
  }

  public supplyImplInstance<TDefinition extends RpcInterface, TImplementation extends TDefinition>(definition: RpcInterfaceDefinition<TDefinition>, instance: TImplementation): void {
    this.suppliedImplementations.set(definition.interfaceName, instance);
  }

  public isRpcInterfaceInitialized<T extends RpcInterface>(definition: RpcInterfaceDefinition<T>): boolean {
    return this.definitionClasses.has(definition.interfaceName);
  }

  public initializeRpcInterface<T extends RpcInterface>(definition: RpcInterfaceDefinition<T>): void {
    if (this.definitionClasses.has(definition.interfaceName))
      return;

    this.notifyInitialize();
    this.definitionClasses.set(definition.interfaceName, definition);
    this.configureOperations(definition);
  }

  public terminateRpcInterface<T extends RpcInterface>(definition: RpcInterfaceDefinition<T>) {
    this.unregisterImpl(definition);
    this.purgeClient(definition);
    this.definitionClasses.delete(definition.interfaceName);
  }

  public definitionClasses: Map<string, RpcInterfaceDefinition> = new Map();
  public proxies: Map<string, RpcInterface> = new Map();
  public implementations: Map<string, RpcInterface> = new Map();
  public suppliedImplementations: Map<string, RpcInterface> = new Map();
  public implementationClasses: Map<string, RpcInterfaceImplementation> = new Map();

  public id = (() => {
    let i = 0;
    return () => ++i;
  })();

  private instantiateImpl<TDefinition extends RpcInterface, TImplementation extends TDefinition>(definition: RpcInterfaceDefinition<TDefinition>): TImplementation {
    this.checkInitialized(definition);

    const registeredImplementation = this.implementationClasses.get(definition.interfaceName) as RpcInterfaceImplementation<TImplementation>;
    if (!registeredImplementation)
      throw new IModelError(BentleyStatus.ERROR, `An RPC interface implementation class for "${definition.interfaceName}" is not registered.`);

    if (definition.prototype.configurationSupplier)
      registeredImplementation.prototype.configurationSupplier = definition.prototype.configurationSupplier;

    const supplied = this.suppliedImplementations.get(definition.interfaceName);
    const implementation = supplied || new registeredImplementation();
    if (!(implementation instanceof registeredImplementation))
      throw new IModelError(BentleyStatus.ERROR, `Invalid RPC interface implementation.`);

    if (supplied) {
      (supplied.configuration as any) = RpcConfiguration.supply(supplied);
    }

    this.implementations.set(definition.interfaceName, implementation);
    implementation.configuration.onRpcImplInitialized(definition, implementation);
    return implementation;
  }

  private instantiateClient<T extends RpcInterface>(definition: RpcInterfaceDefinition<T>): T {
    this.checkInitialized(definition);

    const proxy = new (definition as any)() as T;
    this.proxies.set(definition.interfaceName, proxy);

    Object.getOwnPropertyNames(definition.prototype).forEach((operationName) => {
      if (operationName === "constructor" || operationName === "configurationSupplier")
        return;

      this.interceptOperation(proxy, operationName);
    });

    proxy.configuration.onRpcClientInitialized(definition, proxy);
    return proxy;
  }

  private interceptOperation(proxy: RpcInterface, operation: string) {
    const clientFunction = (proxy as any)[operation];
    // tslint:disable-next-line:only-arrow-functions
    (proxy as any)[operation] = function () {
      const args = Array.from(arguments);
      args.push(operation);
      return clientFunction.apply(proxy, args);
    };
  }

  private checkInitialized<T extends RpcInterface>(definition: RpcInterfaceDefinition<T>) {
    if (!this.definitionClasses.has(definition.interfaceName))
      throw new IModelError(BentleyStatus.ERROR, `RPC interface "${definition.interfaceName}" is not initialized.`);
  }

  private configureOperations<T extends RpcInterface>(definition: RpcInterfaceDefinition<T>) {
    const proto = (definition.prototype as any);

    Object.getOwnPropertyNames(proto).forEach((operationName) => {
      if (operationName === "constructor" || operationName === "configurationSupplier")
        return;

      const propertyName = RpcOperation.computeOperationName(operationName);

      if (!proto[propertyName][OPERATION]) {
        const policy = (definition as any)[POLICY] || new RpcOperationPolicy();
        proto[propertyName][OPERATION] = new RpcOperation(definition, propertyName, policy);
      }
    });
  }

  private purgeClient<T extends RpcInterface>(definition: RpcInterfaceDefinition<T>) {
    const proxy = this.proxies.get(definition.interfaceName);
    if (proxy) {
      proxy.configuration.onRpcClientTerminated(definition, proxy);
      this.proxies.delete(definition.interfaceName);
    }
  }

  private notifyInitialize() {
    initializeRpcRequest();
    RpcPendingQueue.initialize();
  }
}
