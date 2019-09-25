import { Provider, Injectable } from '@ali/common-di';
import { BrowserModule } from '@ali/ide-core-browser';

import { SCMService } from '../common';
import { SCMContribution } from './scm.contribution';
import { SCMBadgeController, SCMStatusBarController, SCMViewController } from './scm-activity';
import { bindSCMPreference } from './scm-preference';
import { DirtyDiffWorkbenchController } from './dirty-diff';

@Injectable()
export class SCMModule extends BrowserModule {
  providers: Provider[] = [
    SCMContribution,
    SCMService,
    SCMBadgeController,
    SCMStatusBarController,
    SCMViewController,
    DirtyDiffWorkbenchController,
  ];

  preferences = bindSCMPreference;
}
