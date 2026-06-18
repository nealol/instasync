import type { Http } from "../http";
import { encodePath } from "../http";
import type {
  BaseViewBody,
  CanvasEdgeBody,
  CanvasNodeBody,
  StructuredResponse,
  StructuredSummary,
} from "../types";

/** Obsidian Canvas files plus node/edge editing. */
export class CanvasesResource {
  constructor(
    private http: Http,
    private vaultId: string,
  ) {}

  private canvas(path: string): string {
    return `/api/vaults/${this.vaultId}/canvas/${encodePath(path)}`;
  }

  list(): Promise<StructuredSummary[]> {
    return this.http.request("GET", `/api/vaults/${this.vaultId}/canvases`);
  }

  create(path: string, value: unknown = {}): Promise<StructuredResponse> {
    return this.http.request("POST", `/api/vaults/${this.vaultId}/canvases`, {
      body: { path, value },
    });
  }

  read(path: string): Promise<StructuredResponse> {
    return this.http.request("GET", this.canvas(path));
  }

  replace(path: string, value: unknown): Promise<StructuredResponse> {
    return this.http.request("PUT", this.canvas(path), { body: { path, value } });
  }

  async delete(path: string): Promise<void> {
    await this.http.request("DELETE", this.canvas(path));
  }

  move(path: string, toPath: string): Promise<StructuredResponse> {
    return this.http.request(
      "POST",
      `/api/vaults/${this.vaultId}/canvas-moves/${encodePath(path)}`,
      {
        body: { toPath },
      },
    );
  }

  addNode(path: string, node: CanvasNodeBody): Promise<StructuredResponse> {
    return this.http.request(
      "POST",
      `/api/vaults/${this.vaultId}/canvas-nodes/${encodePath(path)}`,
      {
        body: node,
      },
    );
  }

  updateNode(
    path: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<StructuredResponse> {
    return this.http.request(
      "PATCH",
      `/api/vaults/${this.vaultId}/canvas-nodes/${encodePath(path)}`,
      {
        body: { id, ...patch },
      },
    );
  }

  deleteNode(path: string, id: string): Promise<StructuredResponse> {
    return this.http.request(
      "DELETE",
      `/api/vaults/${this.vaultId}/canvas-nodes/${encodePath(path)}`,
      {
        body: { id },
      },
    );
  }

  addEdge(path: string, edge: CanvasEdgeBody): Promise<StructuredResponse> {
    return this.http.request(
      "POST",
      `/api/vaults/${this.vaultId}/canvas-edges/${encodePath(path)}`,
      {
        body: edge,
      },
    );
  }

  updateEdge(
    path: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<StructuredResponse> {
    return this.http.request(
      "PATCH",
      `/api/vaults/${this.vaultId}/canvas-edges/${encodePath(path)}`,
      {
        body: { id, ...patch },
      },
    );
  }

  deleteEdge(path: string, id: string): Promise<StructuredResponse> {
    return this.http.request(
      "DELETE",
      `/api/vaults/${this.vaultId}/canvas-edges/${encodePath(path)}`,
      {
        body: { id },
      },
    );
  }
}

/** Obsidian Bases (.base database files) plus view/filter/formula/property editing. */
export class BasesResource {
  constructor(
    private http: Http,
    private vaultId: string,
  ) {}

  private base(path: string): string {
    return `/api/vaults/${this.vaultId}/base/${encodePath(path)}`;
  }

  list(): Promise<StructuredSummary[]> {
    return this.http.request("GET", `/api/vaults/${this.vaultId}/bases`);
  }

  create(path: string, value: unknown = {}): Promise<StructuredResponse> {
    return this.http.request("POST", `/api/vaults/${this.vaultId}/bases`, {
      body: { path, value },
    });
  }

  read(path: string): Promise<StructuredResponse> {
    return this.http.request("GET", this.base(path));
  }

  replace(path: string, value: unknown): Promise<StructuredResponse> {
    return this.http.request("PUT", this.base(path), { body: { path, value } });
  }

  async delete(path: string): Promise<void> {
    await this.http.request("DELETE", this.base(path));
  }

  move(path: string, toPath: string): Promise<StructuredResponse> {
    return this.http.request("POST", `/api/vaults/${this.vaultId}/base-moves/${encodePath(path)}`, {
      body: { toPath },
    });
  }

  listViews(path: string): Promise<unknown> {
    return this.http.request("GET", `/api/vaults/${this.vaultId}/base-views/${encodePath(path)}`);
  }

  addView(path: string, view: BaseViewBody): Promise<StructuredResponse> {
    return this.http.request("POST", `/api/vaults/${this.vaultId}/base-views/${encodePath(path)}`, {
      body: view,
    });
  }

  updateView(
    path: string,
    name: string,
    patch: Record<string, unknown>,
  ): Promise<StructuredResponse> {
    return this.http.request(
      "PATCH",
      `/api/vaults/${this.vaultId}/base-views/${encodePath(path)}`,
      {
        body: { name, ...patch },
      },
    );
  }

  deleteView(path: string, name: string): Promise<StructuredResponse> {
    return this.http.request(
      "DELETE",
      `/api/vaults/${this.vaultId}/base-views/${encodePath(path)}`,
      {
        body: { name },
      },
    );
  }

  setFilters(path: string, value: unknown): Promise<StructuredResponse> {
    return this.http.request(
      "PUT",
      `/api/vaults/${this.vaultId}/base-filters/${encodePath(path)}`,
      {
        body: { value },
      },
    );
  }

  setViewFilters(path: string, viewName: string, value: unknown): Promise<StructuredResponse> {
    return this.http.request(
      "PUT",
      `/api/vaults/${this.vaultId}/base-view-filters/${encodePath(path)}`,
      {
        body: { name: viewName, value },
      },
    );
  }

  setFormula(path: string, name: string, value: unknown): Promise<StructuredResponse> {
    return this.http.request(
      "PUT",
      `/api/vaults/${this.vaultId}/base-formulas/${encodePath(path)}`,
      {
        body: { name, value },
      },
    );
  }

  deleteFormula(path: string, name: string): Promise<StructuredResponse> {
    return this.http.request(
      "DELETE",
      `/api/vaults/${this.vaultId}/base-formulas/${encodePath(path)}`,
      {
        body: { name },
      },
    );
  }

  setProperty(path: string, name: string, value: unknown): Promise<StructuredResponse> {
    return this.http.request(
      "PUT",
      `/api/vaults/${this.vaultId}/base-properties/${encodePath(path)}`,
      {
        body: { name, value },
      },
    );
  }

  deleteProperty(path: string, name: string): Promise<StructuredResponse> {
    return this.http.request(
      "DELETE",
      `/api/vaults/${this.vaultId}/base-properties/${encodePath(path)}`,
      {
        body: { name },
      },
    );
  }
}
