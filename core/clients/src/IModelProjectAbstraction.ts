/*---------------------------------------------------------------------------------------------
|  $Copyright: (c) 2018 Bentley Systems, Incorporated. All rights reserved. $
 *--------------------------------------------------------------------------------------------*/
import { AccessToken } from "./Token";
import { IModelRepository, IModelQuery } from "./imodelhub/iModels";
import { UserProfile } from "./UserProfile";
import { IModelClient } from "./IModelClient";
import { ProgressInfo } from "./Request";
import { Project } from "./ConnectClients";
import { DeploymentEnv } from "./Client";

/** Information needed to create an iModel */
export interface IModelProjectAbstractionIModelCreateParams {
  name: string;
  description: string;
  seedFile: string;
  tracker?: (progress: ProgressInfo) => void;
}

/** Manages users, projects, and imodels and their servers. */
export abstract class IModelProjectAbstraction {

  public abstract isIModelHub: boolean;

  public abstract terminate(): void;

  // User management
  public abstract authorizeUser(userProfile: UserProfile | undefined, userCredentials: any, env: DeploymentEnv): Promise<AccessToken>;

  // Project management
  public abstract queryProject(accessToken: AccessToken, query: any | undefined): Promise<Project>;

  // Server deployment
  public abstract getClientForIModel(projectId: string | undefined, imodelId: string): IModelClient;

  // IModel management
  public abstract createIModel(accessToken: AccessToken, projectId: string, params: IModelProjectAbstractionIModelCreateParams): Promise<IModelRepository>;
  public abstract deleteIModel(accessToken: AccessToken, projectId: string, iModelId: string): Promise<void>;
  public abstract queryIModels(accessToken: AccessToken, projectId: string, query: IModelQuery | undefined): Promise<IModelRepository[]>;
}
