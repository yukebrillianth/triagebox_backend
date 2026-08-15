import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ActivityModule } from './activity/activity.module';
import { AlertsModule } from './alerts/alerts.module';
import { IngestModule } from './ingest/ingest.module';
import { MqttModule } from './mqtt/mqtt.module';
import { NodesModule } from './nodes/nodes.module';
import { OfflineModule } from './offline/offline.module';
import { PrismaModule } from './prisma/prisma.module';
import { StationsModule } from './stations/stations.module';
import { SystemModule } from './system/system.module';
import { VictimsModule } from './victims/victims.module';
import { WsModule } from './ws/ws.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    PrismaModule,
    StationsModule,
    NodesModule,
    ActivityModule,
    VictimsModule,
    AlertsModule,
    IngestModule,
    MqttModule,
    OfflineModule,
    SystemModule,
    WsModule,
  ],
})
export class AppModule {}
