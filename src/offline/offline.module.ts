import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { OfflineService } from './offline.service';

@Module({
  imports: [AlertsModule],
  providers: [OfflineService],
})
export class OfflineModule {}
