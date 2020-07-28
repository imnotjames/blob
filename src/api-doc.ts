import path from 'path';

import yaml from 'yamljs';

import pkgUp from 'pkg-up';

export async function getApiDoc (): Promise<any> {
  const packageJsonFile = await pkgUp();

  const docFile = path.resolve(path.dirname(packageJsonFile), 'reference', 'blob.v1.yaml');

  return yaml.load(docFile);
}
