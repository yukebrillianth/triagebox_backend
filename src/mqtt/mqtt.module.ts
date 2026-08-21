import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { NodesModule } from '../nodes/nodes.module';
import { StationsModule } from '../stations/stations.module';
import { MqttService } from './mqtt.service';

@Module({
  imports: [NodesModule, AlertsModule, StationsModule],
  providers: [MqttService],
  exports: [MqttService],
})
export class MqttModule {}
