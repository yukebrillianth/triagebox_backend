import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { MqttModule } from '../mqtt/mqtt.module';
import { VictimsModule } from '../victims/victims.module';
import { AnalyticsController } from './analytics.controller';
import { HealthController } from './health.controller';
import { KpisController } from './kpis.controller';
import { ReportsController } from './reports.controller';
import { SettingsController } from './settings.controller';
import { SystemService } from './system.service';

@Module({
  imports: [VictimsModule, MqttModule, ActivityModule],
  controllers: [
    KpisController,
    AnalyticsController,
    HealthController,
    SettingsController,
    ReportsController,
  ],
  providers: [SystemService],
})
export class SystemModule {}
