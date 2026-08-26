/**
 * Turning a list of paths into a folder tree.
 *
 * Two lists in the plugin need this: the changes list, and the file list of a
 * single commit. They render very different rows — one stages files, the other
 * opens diffs — but the shape of the tree, the folding of single-child chains
 * and the set of folder paths are the same question both times, and a second
 * copy of that answer is a second copy to keep correct.
 *
 * Pure data, so it is covered without a DOM.
 */

export interface TreeNode<T> {
  name: string;
  /** Full path. For a folder this is what the expanded-folder set keys on. */
  path: string;
  isDir: boolean;
  children: TreeNode<T>[];
  /** The entry a file node stands for. Folders carry nothing. */
  item?: T;
}

/**
 * Builds the folder tree for a list of entries.
 *
 * `compact` folds a chain of folders that each hold a single subfolder into one
 * row — "Projects/cloudcourse" rather than two levels to open before a file
 * shows up.
 */
export function buildFileTree<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  compact: boolean,
): TreeNode<T>[] {
  const root: TreeNode<T>[] = [];
  const dirs = new Map<string, TreeNode<T>>();

  for (const item of items) {
    const parts = pathOf(item).split("/");
    let children = root;
    let path = "";

    for (let i = 0; i < parts.length - 1; i++) {
      path += (path ? "/" : "") + parts[i];
      let dir = dirs.get(path);
      if (!dir) {
        dir = { name: parts[i], path, isDir: true, children: [] };
        dirs.set(path, dir);
        children.push(dir);
      }
      children = dir.children;
    }

    children.push({
      name: parts[parts.length - 1],
      path: pathOf(item),
      isDir: false,
      children: [],
      item,
    });
  }

  return compact ? compactTree(root) : root;
}

/**
 * Folds single-child folder chains together. The merged node keeps the deepest
 * path, so folder actions and the expanded set still key on a directory that
 * exists.
 */
function compactTree<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  return nodes.map((node) => {
    if (!node.isDir) return node;
    let merged = node;
    while (merged.children.length === 1 && merged.children[0].isDir) {
      const child = merged.children[0];
      merged = { ...child, name: `${merged.name}/${child.name}` };
    }
    return { ...merged, children: compactTree(merged.children) };
  });
}

/** Every folder in the tree, however deep — the targets of "expand all". */
export function collectDirPaths<T>(nodes: readonly TreeNode<T>[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (!node.isDir) continue;
    paths.push(node.path);
    paths.push(...collectDirPaths(node.children));
  }
  return paths;
}

/** Every entry below this node, folders walked through. */
export function collectItems<T>(node: TreeNode<T>): T[] {
  const items: T[] = [];
  for (const child of node.children) {
    if (child.isDir) items.push(...collectItems(child));
    else if (child.item !== undefined) items.push(child.item);
  }
  return items;
}
