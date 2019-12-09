import { IDisposable, combinedDisposable, dispose } from '@ali/ide-core-common/lib/disposable';
import { Disposable, Emitter, Event, getLogger } from '@ali/ide-core-common';
import { ISplice } from '@ali/ide-core-common/lib/sequence';
import { observable, computed, action } from 'mobx';
import { Injector, INJECTOR_TOKEN, Injectable, Autowired, Optional } from '@ali/common-di';
import { IMenu } from '@ali/ide-core-browser/lib/menu/next';
import { IContextKey, IContextKeyService } from '@ali/ide-core-browser';

import { ISCMRepository, ISCMResourceGroup, ISCMResource } from '../common';
import { SCMMenus } from './scm-menu';

export interface IGroupItem {
  readonly group: ISCMResourceGroup;
  visible: boolean;
  readonly disposable: IDisposable;
}

export interface IResourceGroupSpliceEvent<T> {
  target: ISCMRepository;
  index: number;
  deleteCount: number;
  elements: T[];
}

export type ISCMDataItem = ISCMResourceGroup | ISCMResource;

export class ResourceGroupSplicer {
  private items: IGroupItem[] = [];
  private disposables: IDisposable[] = [];

  private _onDidSplice = new Emitter<IResourceGroupSpliceEvent<ISCMDataItem>>();
  readonly onDidSplice: Event<IResourceGroupSpliceEvent<ISCMDataItem>> = this._onDidSplice.event;

  constructor(private repository: ISCMRepository) {
  }

  run() {
    const groupSequence = this.repository.provider.groups;
    groupSequence.onDidSplice(this.onDidSpliceGroups, this, this.disposables);
    this.onDidSpliceGroups({ start: 0, deleteCount: 0, toInsert: groupSequence.elements });
  }

  private onDidSpliceGroups({ start, deleteCount, toInsert }: ISplice<ISCMResourceGroup>): void {
    let absoluteStart = 0;

    for (let i = 0; i < start; i++) {
      const item = this.items[i];
      absoluteStart += (item.visible ? 1 : 0) + item.group.elements.length;
    }

    let absoluteDeleteCount = 0;

    for (let i = 0; i < deleteCount; i++) {
      const item = this.items[start + i];
      absoluteDeleteCount += (item.visible ? 1 : 0) + item.group.elements.length;
    }

    const itemsToInsert: IGroupItem[] = [];
    const absoluteToInsert: Array<ISCMResourceGroup | ISCMResource> = [];

    for (const group of toInsert) {
      const visible = isGroupVisible(group);

      if (visible) {
        absoluteToInsert.push(group);
      }

      for (const element of group.elements) {
        absoluteToInsert.push(element);
      }

      const disposable = combinedDisposable([
        group.onDidChange(() => this.onDidChangeGroup(group)),
        group.onDidSplice((splice) => this.onDidSpliceGroup(group, splice)),
      ]);

      itemsToInsert.push({ group, visible, disposable });
    }

    const itemsToDispose = this.items.splice(start, deleteCount, ...itemsToInsert);

    for (const item of itemsToDispose) {
      item.disposable.dispose();
    }

    this._onDidSplice.fire({
      target: this.repository,
      index: absoluteStart,
      deleteCount: absoluteDeleteCount,
      elements: absoluteToInsert,
    });
  }

  private onDidChangeGroup(group: ISCMResourceGroup): void {
    const itemIndex = this.items.findIndex((item) => item.group === group);

    if (itemIndex < 0) {
      return;
    }

    const item = this.items[itemIndex];
    const visible = isGroupVisible(group);

    if (item.visible === visible) {
      return;
    }

    let absoluteStart = 0;

    for (let i = 0; i < itemIndex; i++) {
      const item = this.items[i];
      absoluteStart += (item.visible ? 1 : 0) + item.group.elements.length;
    }

    if (visible) {
      this._onDidSplice.fire({
        target: this.repository,
        index: absoluteStart,
        deleteCount: 0,
        elements: [group, ...group.elements],
      });
    } else {
      this._onDidSplice.fire({
        target: this.repository,
        index: absoluteStart,
        deleteCount: 1 + group.elements.length,
        elements: [],
      });
    }

    item.visible = visible;
  }

  private onDidSpliceGroup(group: ISCMResourceGroup, { start, deleteCount, toInsert }: ISplice<ISCMResource>): void {
    const itemIndex = this.items.findIndex((item) => item.group === group);

    if (itemIndex < 0) {
      return;
    }

    const item = this.items[itemIndex];
    const visible = isGroupVisible(group);

    if (!item.visible && !visible) {
      return;
    }

    let absoluteStart = start;

    for (let i = 0; i < itemIndex; i++) {
      const item = this.items[i];
      absoluteStart += (item.visible ? 1 : 0) + item.group.elements.length;
    }

    if (item.visible && !visible) {
      this._onDidSplice.fire({
        target: this.repository,
        index: absoluteStart,
        deleteCount: 1 + deleteCount,
        elements: toInsert,
      });
    } else if (!item.visible && visible) {
      this._onDidSplice.fire({
        target: this.repository,
        index: absoluteStart,
        deleteCount,
        elements: [group, ...toInsert],
      });
    } else {
      this._onDidSplice.fire({
        target: this.repository,
        index: absoluteStart + 1,
        deleteCount,
        elements: toInsert,
      });
    }

    item.visible = visible;
  }

  dispose(): void {
    this.onDidSpliceGroups({ start: 0, deleteCount: this.items.length, toInsert: [] });
    this.disposables = dispose(this.disposables);
  }
}

function isGroupVisible(group: ISCMResourceGroup) {
  return group.elements.length > 0 || !group.hideWhenEmpty;
}

@Injectable()
export class ViewModelContext extends Disposable {
  @Autowired(INJECTOR_TOKEN)
  private readonly injector: Injector;

  @Autowired(IContextKeyService)
  private readonly contextKeyService: IContextKeyService;

  private scmProviderCtxKey: IContextKey<string | undefined>;

  private logger = getLogger();

  // maybe we must use repo provider id as key
  private scmMenuMap = observable.map<ISCMRepository['provider']['id'], SCMMenus>();

  constructor() {
    super();
    this.scmProviderCtxKey = this.contextKeyService.createKey<string | undefined>('scmProvider', undefined);
  }

  @observable
  public repoList = observable.array<ISCMRepository>([]);

  @observable
  public selectedRepos = observable.array<ISCMRepository>([]);

  @observable
  public selectedRepo: ISCMRepository | undefined;

  @observable
  public scmList = observable.array<ISCMDataItem>([]);

  public titleMenu: IMenu | null;

  private setContextKey(selectedRepo) {
    this.scmProviderCtxKey.set(selectedRepo ? selectedRepo.provider.contextValue : undefined);
  }

  public getSCMMenuService(repository: ISCMRepository | undefined) {
    if (!repository) {
      return undefined;
    }
    return this.scmMenuMap.get(repository.provider.id);
  }

  @action.bound
  public changeSelectedRepos(repos: ISCMRepository[]) {
    this.selectedRepos.replace(repos);
    const selectedRepo = repos[0];
    this.selectedRepo = selectedRepo;
    // set context key
    this.setContextKey(selectedRepo);
  }

  @action.bound
  public addRepo(repo: ISCMRepository) {
    if (this.repoList.indexOf(repo) > -1) {
      this.logger.warn('depulicate scm repo', repo);
      return;
    }
    this.repoList.push(repo);
    // cache SCMMenus for single repo
    const scmMenuService = this.injector.get(SCMMenus, [repo.provider]);
    this.scmMenuMap.set(repo.provider.id, scmMenuService);
  }

  @action
  public deleteRepo(repo: ISCMRepository) {
    const index = this.repoList.indexOf(repo);
    if (index < 0) {
      this.logger.warn('no such scm repo', repo);
      return;
    }
    this.repoList.splice(index, 1);

    const providerId = repo.provider.id;
    const scmMenuService = this.scmMenuMap.get(providerId);
    if (scmMenuService) {
      scmMenuService.dispose();
      this.scmMenuMap.delete(repo.provider.id);
    }
  }

  @action
  public spliceSCMList = (start: number, deleteCount: number, ...toInsert: ISCMDataItem[]) => {
    this.scmList.splice(start, deleteCount, ...toInsert);
  }
}