import { GitLabError } from "../domain/errors.js";
import type { CatalogClient, GitLabInstance } from "../domain/models.js";
import { RestGitLabClient } from "../infrastructure/gitlabClient.js";
import { GitLabHttpClient } from "../infrastructure/http.js";
import type { TokenStore } from "../infrastructure/secretStore.js";

export interface ClientFactory {
  create(instance: GitLabInstance): Promise<CatalogClient>;
  createWithToken(instance: GitLabInstance, token: string): CatalogClient;
}

export class DefaultClientFactory implements ClientFactory {
  public constructor(
    private readonly tokens: TokenStore,
    private readonly getTimeoutMs: () => number,
    private readonly getMaxGetRetries: () => number,
  ) {}

  public async create(instance: GitLabInstance): Promise<CatalogClient> {
    const token = await this.tokens.get(instance.instanceId);
    if (token === undefined || token === "") {
      throw new GitLabError(
        "authentication",
        "No PAT is stored for this GitLab instance.",
      );
    }
    return this.createWithToken(instance, token);
  }

  public createWithToken(
    instance: GitLabInstance,
    token: string,
  ): CatalogClient {
    return new RestGitLabClient(
      new GitLabHttpClient({
        baseUrl: instance.baseUrl,
        token,
        timeoutMs: this.getTimeoutMs(),
        maxGetRetries: this.getMaxGetRetries(),
      }),
    );
  }
}
