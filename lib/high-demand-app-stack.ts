import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';

export class HighDemandAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. VPC: 2 Availability Zones con subredes públicas
    const vpc = new ec2.Vpc(this, 'AppVpc', {
      maxAzs: 2,
      natGateways: 0, // Evita costos extra de NAT Gateway usando subredes públicas para este lab
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
        }
      ]
    });

    // 2. Security Groups
    // ALB acepta tráfico de todo internet en el puerto 80
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, allowAllOutbound: true });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Permitir HTTP desde Internet');

    // EC2 acepta tráfico SOLAMENTE desde el ALB
    const ec2Sg = new ec2.SecurityGroup(this, 'Ec2Sg', { vpc, allowAllOutbound: true });
    ec2Sg.addIngressRule(albSg, ec2.Port.tcp(80), 'Permitir HTTP solo desde el ALB');

    // 3. Rol IAM con mínimo privilegio (Permite acceso seguro vía Session Manager sin llaves SSH)
    const ec2Role = new iam.Role(this, 'Ec2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ]
    });

    // 4. Auto Scaling Group con EBS configurado
    const asg = new autoscaling.AutoScalingGroup(this, 'AppASG', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      minCapacity: 2,
      maxCapacity: 6,
      securityGroup: ec2Sg,
      role: ec2Role,
      associatePublicIpAddress: true, // Necesario al no tener NAT Gateway
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: autoscaling.BlockDeviceVolume.ebs(10, {
            encrypted: true,
            deleteOnTermination: true, // Soluciona la advertencia de cleanup de tu lab
          }),
        }
      ]
    });

    // 5. Configurar el Servidor Web (Apache) al iniciar las instancias
    asg.addUserData(
      'yum update -y',
      'yum install -y httpd',
      'systemctl start httpd',
      'systemctl enable httpd',
      'echo "<h1>Laboratorio SBG - Respuesta desde la instancia: $(hostname -f)</h1>" > /var/www/html/index.html'
    );

    // 6. Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'AppALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    const listener = alb.addListener('Listener', {
      port: 80,
      open: true, // Automáticamente usa el SG del ALB
    });

    // Vincular el ALB con el Auto Scaling Group y configurar Health Checks
    listener.addTargets('Target', {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: '/',
        unhealthyThresholdCount: 2,
        healthyThresholdCount: 2,
        interval: cdk.Duration.seconds(30),
      }
    });

    // 7. BOSS FIGHT: Política de escalado por CPU (Si pasa del 60%)
    asg.scaleOnCpuUtilization('CpuScalingPolicy', {
      targetUtilizationPercent: 60,
      cooldown: cdk.Duration.seconds(60), // Espera 60 segundos antes de evaluar de nuevo
    });

    // 8. Imprimir la URL del ALB en la consola al terminar
    new cdk.CfnOutput(this, 'AlbUrl', {
      value: alb.loadBalancerDnsName,
      description: 'Copia esta URL en tu navegador para ver la app',
    });
  }
}