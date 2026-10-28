import type { ServerConfig } from "./config";
import { FolderConnector, type FolderConnectorOptions } from "./folderConnector";
import { S3Connector, type S3ConnectorOptions } from "./s3Connector";
import { ConnectorError, type StorageConnector } from "./types";

/**
 * Config -> connector. To add a driver (SFTP, Azure Blob, SharePoint...), implement StorageConnector
 * (./types.ts), add its settings to ServerConfig (./config.ts) and add a case here; docs/connectors.md walks
 * through it.
 */
export function createConnector(cfg: ServerConfig, options: { folder?: FolderConnectorOptions; s3?: S3ConnectorOptions } = {}): StorageConnector {
  switch (cfg.type) {
    case "folder":
      return new FolderConnector(cfg.path, options.folder);
    case "s3":
      return new S3Connector(cfg, options.s3);
    case "none":
      throw new ConnectorError("config", "No storage server is configured (LOCUS_SERVER_TYPE is none).");
  }
}
