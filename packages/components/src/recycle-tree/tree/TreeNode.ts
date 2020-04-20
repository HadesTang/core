import { ITreeNodeOrCompositeTreeNode, ITreeNode, ICompositeTreeNode, TreeNodeEvent, IWatcherEvent, MetadataChangeType, ITreeWatcher, IMetadataChange, ITree, WatchEvent, TreeNodeType, TopDownIteratorCallback  } from '../types';
import { Event, Emitter, DisposableCollection } from '@ali/ide-core-common';
import { Path } from '@ali/ide-core-common/lib/path';
import { IWatcherCallback, IWatchTerminator, IWatcherInfo } from '../types';

/**
 * 除了此方法不会抛出RangeError错误，其余表现与Array.prototype.splice一样，
 *
 * 性能与Array.prototype.splice大致相同，某些场景如safari下表现更好
 *
 * @param arr 裁剪数组
 * @param start 起始位置
 * @param deleteCount 删除或替换位置
 * @param items 插入的数组
 */
export function spliceTypedArray(arr: Uint32Array, start: number, deleteCount: number = 0, items?: Uint32Array | null) {
  const a = new Uint32Array((arr.length - deleteCount) + (items ? items.length : 0));
  a.set(arr.slice(0, start));
  if (items) {
    a.set(items, start);
  }
  a.set(arr.slice(start + deleteCount, arr.length), (start + (items ? items.length : 0)));
  return a;
}

export type TreeNodeOrCompositeTreeNode = TreeNode | CompositeTreeNode;

export class TreeNode implements ITreeNode {
  public static nextId = (() => {
    let id = 0;
    return () => id++;
  })();

  public static is(node: any): node is ITreeNode {
    return !!node && 'depth' in node && 'name' in node && 'path' in node && 'id' in node;
  }

  public static getTreeNodeById(id: number) {
    return TreeNode.idToTreeNode.get(id);
  }

  private static idToTreeNode: Map<number, TreeNode> = new Map();
  protected _uid: number;
  protected _depth: number;
  private _parent: ICompositeTreeNode | undefined;

  private _metadata: {
    [key: string]: any,
  };

  private _disposed: boolean;
  protected _watcher: ITreeWatcher;

  protected _tree: ITree;
  private resolvedPathCache: string;

  protected constructor(tree: ITree, parent?: ICompositeTreeNode, watcher?: ITreeWatcher, optionalMetadata?: { [key: string]: any }) {
    this._uid = TreeNode.nextId();
    this._parent = parent;
    this._tree = tree;
    this._disposed = false;
    this._metadata = { ...(optionalMetadata || {}) };
    this._depth = parent ? parent.depth + 1 : 0;
    if (watcher) {
      this._watcher = watcher;
    } else if (parent) {
      this._watcher = (parent as any).watcher;
    }
    TreeNode.idToTreeNode.set(this._uid, this);
  }

  get disposed() {
    return this._disposed;
  }

  /**
   * 获取基础信息
   */
  get depth() {
    return this._depth;
  }

  get parent() {
    return this._parent;
  }

  set parent(node: ICompositeTreeNode | undefined) {
    this._parent = node;
  }

  get type() {
    return TreeNodeType.TreeNode;
  }

  get id() {
    return this._uid;
  }

  get name() {
    return this.getMetadata('name');
  }

  set name(name: string) {
    this.addMetadata('name', name);
  }

  // 节点绝对路径
  get path(): string {
    if (!this.parent) {
      return new Path(`/${this.name}`).toString();
    }
    if (!this.resolvedPathCache) {
      this.resolvedPathCache = new Path(this.parent.path).join(this.name).toString();
    }
    return this.resolvedPathCache;
  }

  public getMetadata(withKey: string): any {
    return this._metadata[withKey];
  }

  public addMetadata(withKey: string, value: any) {
    if (!(withKey in this._metadata)) {
      this._metadata[withKey] = value;
      this._watcher.notifyDidChangeMetadata(this, { type: MetadataChangeType.Added, key: withKey, prevValue: void 0, value });
    } else {
      const prevValue = this._metadata[withKey];
      this._metadata[withKey] = value;
      this._watcher.notifyDidChangeMetadata(this, { type: MetadataChangeType.Updated, key: withKey, prevValue, value });
    }
  }

  public removeMetadata(withKey: string) {
    if (withKey in this._metadata) {
      const prevValue = this._metadata[withKey];
      delete this._metadata[withKey];
      this._watcher.notifyDidChangeMetadata(this, { type: MetadataChangeType.Removed, key: withKey, prevValue, value: void 0 });
    }
  }

  /**
   * 这里的move操作可能为移动，也可能为重命名
   *
   * @param {ICompositeTreeNode} to
   * @param {string} [name=this.name]
   * @returns
   * @memberof TreeNode
   */
  public mv(to: ICompositeTreeNode | null, name: string = this.name) {
    // 一个普通节点必含有父节点，根节点不允许任何操作
    const prevParent = this._parent as CompositeTreeNode;
    if (to === null || !CompositeTreeNode.is(to)) {
      this._parent = undefined;
      this.dispose();
      return;
    }
    const didChangeParent = prevParent !== to;
    const prevPath = this.path;

    this.resolvedPathCache = '';
    this._depth = to.depth + 1;

    if (didChangeParent || name !== this.name) {
      this.name = name;
      if (didChangeParent) {
        this._watcher.notifyWillChangeParent(this, prevParent, to);
      }
      if (this.parent) {
        (this.parent as CompositeTreeNode).unlinkItem(this, true);
        this._parent = to;
        (this.parent as CompositeTreeNode).insertItem(this);
      }
      if (didChangeParent) {
        this._watcher.notifyDidChangeParent(this, prevParent, to);
      }
    }

    if (this.path !== prevPath) {
      this._watcher.notifyDidChangePath(this);
    }
  }

  protected dispose() {
    if (this._disposed) { return; }
    this._watcher.notifyWillDispose(this);
    this._disposed = true;
    TreeNode.idToTreeNode.delete(this._uid);
    this._watcher.notifyDidDispose(this);
  }
}

export class CompositeTreeNode extends TreeNode implements ICompositeTreeNode {

  private static defaultSortComparator(a: ITreeNodeOrCompositeTreeNode, b: ITreeNodeOrCompositeTreeNode) {
    if (a.constructor === b.constructor) {
      return a.name > b.name ? 1
        : a.name < b.name ? -1
          : 0;
    }
    return CompositeTreeNode.is(a) ? -1
      : CompositeTreeNode.is(b)  ? 1
        : 0;
  }

  public static is(node: any): node is ICompositeTreeNode {
    return !!node && 'children' in node;
  }

  public static isRoot(node: any): boolean {
    return CompositeTreeNode.is(node) && !node.parent;
  }

  protected _children: ITreeNodeOrCompositeTreeNode[] | null = null;
  // 节点的分支数量
  protected _branchSize: number;
  protected flattenedBranch: Uint32Array | null;
  private isExpanded: boolean;
  private hardReloadPromise: Promise<void> | null;
  private hardReloadPResolver: (() => void) | null;

  private watchTerminator: (path: string) => void;
  public watchEvents: Map<string, IWatcherInfo>;

  protected generatorWatcher() {
    const emitter = new Emitter<any>();
    const onEventChanges: Event<any> = emitter.event;
    const disposeCollection = new DisposableCollection();
    const terminateWatch = (path: string) => {
      this.watchEvents.delete(path);
    };
    const watcher: ITreeWatcher = {
      notifyWillProcessWatchEvent: (target: ICompositeTreeNode, event: IWatcherEvent) => {
        emitter.fire({type: TreeNodeEvent.WillProcessWatchEvent, args: [target, event]});
      },
      notifyWillChangeParent: (target: ITreeNodeOrCompositeTreeNode, prevParent: ICompositeTreeNode, newParent: ICompositeTreeNode) => {
        emitter.fire({type: TreeNodeEvent.WillChangeParent, args: [target, prevParent, newParent]});
      },
      notifyDidChangeParent: (target: ITreeNodeOrCompositeTreeNode, prevParent: ICompositeTreeNode, newParent: ICompositeTreeNode)  => {
        emitter.fire({type: TreeNodeEvent.DidChangeParent, args: [target, prevParent, newParent]});
      },
      notifyWillDispose: (target: ITreeNodeOrCompositeTreeNode)   => {
        emitter.fire({type: TreeNodeEvent.DidChangeParent, args: [target]});
      },
      notifyDidDispose: (target: ITreeNodeOrCompositeTreeNode)  => {
        emitter.fire({type: TreeNodeEvent.DidChangeParent, args: [target]});
      },
      notifyDidProcessWatchEvent: (target: ICompositeTreeNode, event: IWatcherEvent)  => {
        emitter.fire({type: TreeNodeEvent.DidProcessWatchEvent, args: [target, event]});
      },
      notifyDidChangePath: (target: ITreeNodeOrCompositeTreeNode)  => {
        emitter.fire({type: TreeNodeEvent.DidChangePath, args: [target]});
      },
      notifyWillChangeExpansionState: (target: ICompositeTreeNode, nowExpanded: boolean)   => {
        const isVisible = this.isItemVisibleAtSurface(target);
        emitter.fire({type: TreeNodeEvent.WillChangeExpansionState, args: [target, nowExpanded, isVisible]});
      },
      notifyDidChangeExpansionState: (target: ICompositeTreeNode, nowExpanded: boolean)  => {
        const isVisible = this.isItemVisibleAtSurface(target);
        emitter.fire({type: TreeNodeEvent.DidChangeExpansionState, args: [target, nowExpanded, isVisible]});
      },
      notifyDidChangeMetadata: (target: ITreeNode | ICompositeTreeNode, change: IMetadataChange)  => {
        emitter.fire({type: TreeNodeEvent.DidChangeMetadata, args: [target, change]});
      },
      notifyDidUpdateBranch: () => {
        emitter.fire({type: TreeNodeEvent.BranchDidUpdate, args: []});
      },
      notifyWillResolveChildren: (target: ICompositeTreeNode, nowExpanded: boolean) => {
        emitter.fire({type: TreeNodeEvent.WillResolveChildren, args: [target, nowExpanded]});
      },
      notifyDidResolveChildren: (target: ICompositeTreeNode, nowExpanded: boolean) => {
        emitter.fire({type: TreeNodeEvent.DidResolveChildren, args: [target, nowExpanded]});
      },
      // 监听所有事件
      on: (event: TreeNodeEvent, callback: any) => {
        const dispose = onEventChanges((data) => {
          if (data.type === event) {
            callback(...data.args);
          }
        });
        disposeCollection.push(dispose);
        return dispose;
      },
      // 监听Watch事件变化
      onWatchEvent: (path: string, callback: IWatcherCallback): IWatchTerminator => {
        const terminator: IWatchTerminator = terminateWatch;
        this.watchEvents.set(path, { terminator, callback });
        return terminator;
      },
      dispose: disposeCollection,
    };
    return watcher;
  }

  // parent 为undefined即表示该节点为根节点
  constructor(tree: ITree, parent: ICompositeTreeNode | undefined, watcher?: ITreeWatcher, optionalMetadata?: { [key: string]: any }) {
    super(tree, parent, watcher, optionalMetadata);
    this.isExpanded = !!parent ? false : true;
    this._branchSize = 0;
    if (!parent) {
      this.watchEvents = new Map();
      // 为根节点创建监听器
      this._watcher = this.generatorWatcher();
    } else {
      this._watcher = (parent as any).watcher;
    }
  }

  // 作为根节点唯一的watcher需要在生成新节点的时候传入
  get watcher() {
    return this._watcher;
  }

  get type() {
    return TreeNodeType.CompositeTreeNode;
  }

  get children() {
    return this._children ? this._children.slice() : null;
  }

  get expanded() {
    return this.isExpanded;
  }

  /**
   * 当前可见的分支数量
   *
   * 当节点为展开状态时，其整个分支（递归展平）由上一级的分支（根（位于数据层可见）或处于折叠状态的分支）拥有
   * 当节点为折叠状态时，其整个分支（递归展平）由其上一级父目录展开该节点
   *
   * @readonly
   * @memberof CompositeTreeNode
   */
  get branchSize() {
    return this._branchSize;
  }

  /**
   * 确保此“目录”的子级已加载（不影响“展开”状态）
   * 如果子级已经加载，则返回的Promise将立即解决
   * 否则，将发出重新加载请求并返回Promise
   * 一旦返回的Promise.resolve，“CompositeTreeNode＃children” 便可以访问到对于节点
   */
  public async ensureLoaded() {
    if (this._children) {
      return;
    }
    return this.hardReloadChildren();
  }

  // 展开节点
  public async setExpanded(ensureVisible = true) {
    // 根节点不可折叠
    if (CompositeTreeNode.isRoot(this)) {
      return;
    }
    if (this.isExpanded) {
      return;
    }
    this.isExpanded = true;
    if (this._children === null) {
      this._watcher.notifyWillResolveChildren(this, this.isExpanded);
      await this.hardReloadChildren();
      this._watcher.notifyDidResolveChildren(this, this.isExpanded);
      // 检查其是否展开；可能同时执行了setCollapsed方法
      if (!this.isExpanded) {
        return;
      }
    }

    if (ensureVisible && this.parent) {
      await (this.parent as CompositeTreeNode).setExpanded(true);
    }

    if (this.isExpanded) {
      this._watcher.notifyWillChangeExpansionState(this, true);
      // 与根节点合并分支
      this.expandBranch(this);
      this._watcher.notifyDidChangeExpansionState(this, true);
    }
  }

  // 折叠节点
  public setCollapsed() {
    // 根节点不可折叠
    if (CompositeTreeNode.isRoot(this)) {
      return;
    }
    if (!this.isExpanded) {
      return;
    }
    if (this._children && this.parent) {
      this._watcher.notifyWillChangeExpansionState(this, false);
      // 从根节点裁剪分支
      this.shrinkBranch(this);
    }
    this.isExpanded = false;

    this._watcher.notifyDidChangeExpansionState(this, false);
  }

  public mv(to: ICompositeTreeNode, name: string = this.name) {
    const prevPath = this.path;
    super.mv(to, name);
    if (typeof this.watchTerminator === 'function') {
      this.watchTerminator(prevPath);
      if (this._children) {
        this.watchTerminator = this.watcher.onWatchEvent(this.path, this.handleWatchEvent);
      }
    }
    // 同时移动过子节点
    if (this.children) {
      for (const child of this.children) {
        child.mv(child.parent as ICompositeTreeNode, child.name);
      }
    }
  }

  /**
   * 在节点中插入新的节点
   *
   * 直接调用此方法将不会触发onWillHandleWatchEvent和onDidHandleWatchEvent事件
   */
  public insertItem(item: ITreeNodeOrCompositeTreeNode) {
    if (item.parent !== this) {
      item.mv(this, item.name);
      return;
    }
    if (this.children) {
      for (let i = 0; i < this.children.length; i++) {
        if (this.children[i].name === item.name) {
          this.children[i] = item;
          return;
        }
      }
    }
    const branchSizeIncrease = 1 + ((item instanceof CompositeTreeNode && item.expanded) ? item._branchSize : 0);
    if (this._children) {
      this._children.push(item);
      this._children.sort(this._tree.sortComparator || CompositeTreeNode.defaultSortComparator);
    }
    this._branchSize += branchSizeIncrease;
    let master: CompositeTreeNode = this;
    // 如果该节点无叶子节点，则继续往上查找合适的插入位置
    while (!master.flattenedBranch) {
      if (master.parent) {
        master = master.parent as CompositeTreeNode;
        master._branchSize += branchSizeIncrease;
      }
    }
    if (!this._children) {
      return;
    }
    let relativeInsertionIndex = this._children!.indexOf(item);
    const leadingSibling = this._children![relativeInsertionIndex - 1];
    if (leadingSibling) {
      const siblingIdx = master.flattenedBranch.indexOf(leadingSibling.id);
      relativeInsertionIndex = siblingIdx + ((leadingSibling instanceof CompositeTreeNode && leadingSibling.expanded) ? leadingSibling._branchSize : 0);
    } else {
      relativeInsertionIndex = master.flattenedBranch.indexOf(this.id);
    }
    // +1为了容纳自身节点位置，在插入节点下方插入新增节点
    const absInsertionIndex = relativeInsertionIndex + 1;

    const branch = new Uint32Array(branchSizeIncrease);
    branch[0] = item.id;
    if (item instanceof CompositeTreeNode && item.expanded && item.flattenedBranch) {
      branch.set(item.flattenedBranch, 1);
      item.setFlattenedBranch(null);
    }
    master.setFlattenedBranch(spliceTypedArray(master.flattenedBranch, absInsertionIndex, 0, branch));
  }

  /**
   * 从父节点中移除节点
   *
   * 直接调用此方法将不会触发onWillHandleWatchEvent和onDidHandleWatchEvent事件
   */
  public unlinkItem(item: ITreeNodeOrCompositeTreeNode, reparenting?: boolean): void {
    if (!this._children) {
      return;
    }
    const idx = this._children!.indexOf(item);
    if (idx === -1) {
      return;
    }
    this._children!.splice(idx, 1);
    const branchSizeDecrease = 1 + ((item instanceof CompositeTreeNode && item.expanded) ? item._branchSize : 0);
    this._branchSize -= branchSizeDecrease;
    // 逐级往上查找节点的父节点，并沿途裁剪分支数
    let master: CompositeTreeNode = this;
    while (!master.flattenedBranch) {
      if (master.parent) {
        master = master.parent as CompositeTreeNode;
        master._branchSize -= branchSizeDecrease;
      }
    }
    const removalBeginIdx = master.flattenedBranch.indexOf(item.id);
    if (removalBeginIdx === -1) {
      return;
    }

    if (item instanceof CompositeTreeNode && item.expanded) {
      item.setFlattenedBranch(master.flattenedBranch.slice(removalBeginIdx + 1, removalBeginIdx + branchSizeDecrease));
    }

    master.setFlattenedBranch(spliceTypedArray(
      master.flattenedBranch,
      removalBeginIdx,
      branchSizeDecrease));

    if (!reparenting && item.parent === this) {
      item.mv(null);
    }
  }

  /**
   * 转换节点路径
   *
   */
  private transferItem(oldPath: string, newPath: string) {
    const oldP = new Path(oldPath);
    const from = oldP.dir.toString();
    if (from !== this.path) {
      return;
    }
    const name = oldP.base.toString();
    const item = this._children!.find((c) => c.name === name);
    if (!item) {
      return;
    }
    const newP = new Path(newPath);
    const to = newP.dir.toString();
    const { root } = this._tree;
    const destDir = to === from ? this : root!.findTreeNodeInLoadedTree(to);
    if (!(CompositeTreeNode.is(destDir))) {
      this.unlinkItem(item);
      return;
    }
    item.mv(destDir, newP.base.toString());
  }

  protected dispose() {
    // 如果存在对应文件路径下的监听，同样需要清理掉
    if (this.watchEvents) {
      const watcher = this.watchEvents.get(this.path);
      if (watcher) {
        watcher.terminator();
      }
    }
    if (this._children) {
      this._children.forEach((child) => (child as CompositeTreeNode).dispose());
    }
    super.dispose();
  }

  /**
   * 设置扁平化的分支信息
   */
  protected setFlattenedBranch(leaves: Uint32Array | null) {
    this.flattenedBranch = leaves;
    // Root节点才通知更新
    if (CompositeTreeNode.isRoot(this)) {
      this.watcher.notifyDidUpdateBranch();
    }
  }

  /**
   * 展开分支节点
   * @param branch 分支节点
   */
  protected expandBranch(branch: CompositeTreeNode) {
    if (this !== branch) {
      // 但节点为展开状态时进行裁剪
      this._branchSize += branch._branchSize;
    }
    // 当当前节点为折叠状态，更新分支信息
    if (this !== branch && this.flattenedBranch) {
      const injectionStartIdx = this.flattenedBranch.indexOf(branch.id) + 1;
      this.setFlattenedBranch(spliceTypedArray(this.flattenedBranch, injectionStartIdx, 0, branch.flattenedBranch));
      // 取消展开分支对于分支的所有权，即最终只会有顶部Root拥有所有分支信息
      branch.setFlattenedBranch(null);
    } else if (this.parent) {
      (this.parent as CompositeTreeNode).expandBranch(branch);
    }
  }

  /**
   * 清理分支节点
   * @param branch 分支节点
   */
  protected shrinkBranch(branch: CompositeTreeNode) {
    if (this !== branch) {
      // 这里的`this`实际上为父节点
      // `this`的分支大小没有改变，仍然具有相同数量的叶子，但是从父级参照系（即根节点）来看，其分支缩小了
      this._branchSize -= branch._branchSize;
    }
    if (this !== branch && this.flattenedBranch) {
      const removalStartIdx = this.flattenedBranch.indexOf(branch.id) + 1;
      // 返回分支对于分支信息所有权，即将折叠的节点信息再次存储于折叠了的节点中
      branch.setFlattenedBranch(this.flattenedBranch.slice(removalStartIdx, removalStartIdx + branch._branchSize));
      this.setFlattenedBranch(spliceTypedArray(this.flattenedBranch, removalStartIdx, branch.flattenedBranch ? branch.flattenedBranch.length : 0));
    } else if (this.parent) {
      (this.parent as CompositeTreeNode).shrinkBranch(branch);
    }
  }

  /**
   * 加载节点信息
   * @memberof CompositeTreeNode
   */
  protected async hardReloadChildren() {
    if (this.hardReloadPromise) {
      return this.hardReloadPromise;
    }
    this.hardReloadPromise = new Promise((res) => this.hardReloadPResolver = res);
    this.hardReloadPromise.then(() => {
      this.hardReloadPromise = null;
      this.hardReloadPResolver = null;
    });

    const rawItems = await this._tree.resolveChildren(this) || [];

    if (this._children) {
      // 重置节点分支
      this.shrinkBranch(this);
    }

    const flatTree = new Uint32Array(rawItems.length);
    this._children = Array(rawItems.length);
    for (let i = 0; i < rawItems.length; i++) {
      const child = rawItems[i];
      this._children[i] = child;
    }

    this._children.sort(this._tree.sortComparator || CompositeTreeNode.defaultSortComparator);

    for (let i = 0; i < rawItems.length; i++) {
      flatTree[i] = this._children[i].id;
    }
    this._branchSize = flatTree.length;
    this.setFlattenedBranch(flatTree);
    // 清理上一次监听函数
    if ( typeof this.watchTerminator === 'function') {
      this.watchTerminator(this.path);
    }
    this.watchTerminator = this.watcher.onWatchEvent(this.path, this.handleWatchEvent);
    if (this.hardReloadPResolver) {
      this.hardReloadPResolver();
    }
  }

  /**
   * 处理Watch事件，同时可通过外部手动调用节点更新函数进行节点替换，这里为通用的事件管理
   * 如： transferItem，insertItem, unlinkItem等
   * @private
   * @memberof CompositeTreeNode
   */
  private handleWatchEvent = async (event: IWatcherEvent) => {
    this.watcher.notifyWillProcessWatchEvent(this, event);
    if (event.type === WatchEvent.Moved) {
      const { oldPath, newPath } = event;
      if (typeof oldPath !== 'string') { throw new TypeError(`Expected oldPath to be a string`); }
      if (typeof newPath !== 'string') { throw new TypeError(`Expected newPath to be a string`); }
      if (Path.isRelative(oldPath)) { throw new TypeError(`oldPath must be absolute`); }
      if (Path.isRelative(newPath)) { throw new TypeError(`newPath must be absolute`); }
      this.transferItem(oldPath, newPath);
    } else if (event.type === WatchEvent.Added) {
      const { node } = event;
      if (!TreeNode.is(node)) {
        throw new TypeError(`Expected node to be a TreeNode`);
      }
      this.insertItem(node);
    } else if (event.type === WatchEvent.Removed) {
      const { path } = event;
      const pathObject  = new Path(path);
      const dirName = pathObject.dir.toString();
      const name = pathObject.base.toString();
      if (dirName === this.path && !! this.children) {
        const item = this.children.find((c) => c.name === name);
        if (item) {
          this.unlinkItem(item);
        }
      }
    } else {
      //  Changed事件，表示节点有较多的变化时，重新更新当前Tree节点
      if (!! this.children) {
        for (const child of this.children) {
          (child as CompositeTreeNode).dispose();
        }
      }
      // 如果当前变化的节点已在数据视图（并非滚动到不可见区域）中不可见，则将该节点折叠，待下次更新即可，
      if (!this.isItemVisibleAtRootSurface(this)) {
        this.isExpanded = false;
        this._children = null;
      } else {
        await this.hardReloadChildren();
        this.expandBranch(this);
      }
    }
    this.watcher.notifyDidProcessWatchEvent(this, event);
  }

  private isItemVisibleAtRootSurface(node: TreeNode) {
    let parent: ITreeNodeOrCompositeTreeNode = node;
    while (parent.parent) {
      parent = parent.parent;
    }
    return (parent as CompositeTreeNode).isItemVisibleAtSurface(node);
  }

  /**
   * 检查节点是否可见，而不是被隐藏在节点中
   *
   * 这里的可见并不表示节点在当前视图中可见，而是在用户滚动到特定位置便可看见
   *
   * 隐藏在节点中可能的原因为其父节点中有一个以上处于折叠状态
   */
  public isItemVisibleAtSurface(item: ITreeNodeOrCompositeTreeNode): boolean {
    if (item === this) {
      return true;
    }
    return !!this.flattenedBranch && this.flattenedBranch.indexOf(item.id) > -1;
  }

  private transformToRelativePath(path: string): string[] {
    const { splitPath } = Path;
    const pathFlag = splitPath(path);
    pathFlag.shift();
    return pathFlag;
  }

  /**
   * 从加载的Tree中根据路径查找节点
   * @param path
   */
  public findTreeNodeInLoadedTree(path: string): ITreeNodeOrCompositeTreeNode | undefined {
    const pathFlag = Path.isRelative(path) ? Path.splitPath(path) : this.transformToRelativePath(path);
    if (pathFlag.length === 0) {
      return this;
    }
    let next = this._children;
    let name;
    while (!!next && (name = pathFlag.shift())) {
      const item = next.find((c) => c.name === name);
      if (item && pathFlag.length === 0) {
        return item;
      }
      // 异常情况
      if (!item || (!CompositeTreeNode.is(item) && pathFlag.length > 0)) {
        return;
      }
      if (CompositeTreeNode.is(item)) {
        if (!(item as CompositeTreeNode)._children) {
          return ;
        }
        next = (item as CompositeTreeNode)._children;
      }
    }
  }

  /**
   * 根据路径展开节点树
   * @memberof CompositeTreeNode
   */
  public async forceLoadTreeNodeAtPath(path: string): Promise<ITreeNodeOrCompositeTreeNode | undefined> {
    const { splitPath, isRelative } = Path;
    const pathFlag = isRelative(path) ? splitPath(path) : this.transformToRelativePath(path);
    if (pathFlag.length === 0) {
      return this;
    }
    await this.ensureLoaded();
    let next = this._children;
    let name;
    while (name = pathFlag.shift()) {
      const item = next!.find((c) => c.name === name);
      if (item && pathFlag.length === 0) {
        return item;
      }
      // 异常情况
      if (!item || (!CompositeTreeNode.is(item) && pathFlag.length > 0)) {
        return ;
      }
      if (CompositeTreeNode.is(item)) {
        if (!(item as CompositeTreeNode)._children) {
          await (item as CompositeTreeNode).hardReloadChildren();
        }
        next = (item as CompositeTreeNode)._children;
      }
    }
  }

  /**
   * 根据节点获取节点ID下标位置
   * @param {number} id
   * @returns
   * @memberof CompositeTreeNode
   */
  public getIndexAtTreeNodeId(id: number) {
    if (this.flattenedBranch) {
      return this.flattenedBranch.indexOf(id);
    }
    return -1;
  }

  /**
   * 根据节点获取节点下标位置
   * @param {ITreeNodeOrCompositeTreeNode} node
   * @returns
   * @memberof CompositeTreeNode
   */
  public getIndexAtTreeNode(node: ITreeNodeOrCompositeTreeNode) {
    if (this.flattenedBranch) {
      return this.flattenedBranch.indexOf(node.id);
    }
    return -1;
  }

  /**
   * 根据下标位置获取节点
   * @param {number} index
   * @returns
   * @memberof CompositeTreeNode
   */
  public getTreeNodeAtIndex(index: number) {
    const id = this.flattenedBranch![index];
    return TreeNode.getTreeNodeById(id);
  }

  /**
   * 根据节点ID获取节点
   * @param {number} id
   * @returns
   * @memberof CompositeTreeNode
   */
  public getTreeNodeById(id: number) {
    return TreeNode.getTreeNodeById(id);
  }

  /**
   * 从指定节点开始遍历所有节点
   * @param {TopDownIteratorCallback} callback
   * @param {CompositeTreeNode} [startingPoint=this]
   * @memberof CompositeTreeNode
   */
  public async iterateTopDown(callback: TopDownIteratorCallback, startingPoint: CompositeTreeNode = this) {
    const stack: Array<IterableIterator<(TreeNodeOrCompositeTreeNode)>> = [];
    let curIterable: IterableIterator<TreeNodeOrCompositeTreeNode>;
    let curItem: TreeNodeOrCompositeTreeNode = startingPoint;
    let exited = false;
    const exit = () => exited = true;

    const stepIn = async () => {
      if (curItem.type !== TreeNodeType.CompositeTreeNode) {
        throw new Error(`stepIn can only be called on CompositeTreeNode`);
      }
      if (!(curItem as CompositeTreeNode)._children) {
        await (curItem as CompositeTreeNode).ensureLoaded();
      }
      curIterable = (curItem as CompositeTreeNode)._children!.values() as IterableIterator<TreeNodeOrCompositeTreeNode>;
      stack.push(curIterable);
      next();
    };

    const stepOut = async () => {
      if (stack.length === 1) {
        throw new Error('Cannot stepOut of startingPoint');
      }
      curIterable = stack.pop() as IterableIterator<TreeNodeOrCompositeTreeNode>;
      await next();
    };

    const next = async () => {
      curItem = curIterable.next().value;
      if (exited) { return; }
      await callback(curItem, next, stepIn, stepOut, exit);
    };

    await stepIn();
  }

}