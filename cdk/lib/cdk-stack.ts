import { Stack, StackProps, RemovalPolicy, Duration, SecretValue } from "aws-cdk-lib";
import dotenv from "dotenv";
import {
  Vpc,
  IpAddresses,
  SubnetType,
  GatewayVpcEndpointAwsService,
  InterfaceVpcEndpointAwsService,
  SecurityGroup,
  Peer,
  Port,
} from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  FargatePlatformVersion,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";
import { getConfig } from "../config";
import { Repository } from "aws-cdk-lib/aws-ecr";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion } from "aws-cdk-lib/aws-rds";

dotenv.config();

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const config = getConfig();

    // ECR
    const appRepository = new Repository(this, "WatanabeAppRepository", {
      repositoryName: "watanabe-app",
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const webRepository = new Repository(this, "WatanabeWebRepository", {
      repositoryName: "watanabe-web",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Container Image from ECR
    const appImage = ContainerImage.fromEcrRepository(appRepository);
    const webImage = ContainerImage.fromEcrRepository(webRepository);

    // Vpc
    const vpc = new Vpc(this, "WatanabeVpc", {
      vpcName: "WatanabeVpc",
      availabilityZones: ["ap-northeast-1a", "ap-northeast-1c"],
      ipAddresses: IpAddresses.cidr("10.0.0.0/16"),
      subnetConfiguration: [
        {
          name: "WatanabePublic",
          cidrMask: 24,
          subnetType: SubnetType.PUBLIC,
        },
        {
          name: "WatanabePrivate",
          cidrMask: 24,
          subnetType: SubnetType.PRIVATE_ISOLATED,
        },
      ],
      natGateways: 0,
      createInternetGateway: true,
    });

    // Vpc Endpoints
    vpc.addInterfaceEndpoint("EcrEndpoint", {
      service: InterfaceVpcEndpointAwsService.ECR,
    });
    vpc.addInterfaceEndpoint("EcrDkrEndpoint", {
      service: InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });
    vpc.addInterfaceEndpoint("CwLogsEndpoint", {
      service: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: GatewayVpcEndpointAwsService.S3,
      subnets: [
        {
          subnetType: SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Security Group for ALB
    const albSg = new SecurityGroup(this, "WatanabeAlbSg", {
      vpc: vpc,
      securityGroupName: "WatanabeAlbSg",
    });
    albSg.addIngressRule(Peer.anyIpv4(), Port.tcp(443));

    // Security Group for Fargate
    const fargateSg = new SecurityGroup(this, "WatanabeFargateSg", {
      vpc: vpc,
      securityGroupName: "WatanabeFargateSg",
    });
    fargateSg.addIngressRule(albSg, Port.tcp(80));

    // Security Group for DB
    const dbSg = new SecurityGroup(this, "WatanabeDbSg", {
      vpc: vpc,
      securityGroupName: "WatanabeDbSg",
    });
    dbSg.addIngressRule(fargateSg, Port.tcp(5432));

    // DB
    const dbCredentials = Credentials.fromPassword("postgres", SecretValue.unsafePlainText(config.dbPassword));
    const db = new DatabaseInstance(this, "WatanabeDb", {
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_17 }),
      multiAz: false,
      securityGroups: [dbSg],
      credentials: dbCredentials,
      publiclyAccessible: false,
      removalPolicy: RemovalPolicy.DESTROY,
      deletionProtection: false,
      databaseName: "watanabeDb",
    });

    // ALB
    const alb = new ApplicationLoadBalancer(this, "WatanabeAlb", {
      vpc: vpc,
      internetFacing: true,
      loadBalancerName: "WatanabeAlb",
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
      },
      securityGroup: albSg,
    });

    // Target Group
    const targetGroup = new ApplicationTargetGroup(
      this,
      "WatanabeTargetGroup",
      {
        vpc: vpc,
        targetType: TargetType.IP,
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        healthCheck: {
          healthyHttpCodes: "200",
          path: "/",
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
        },
      }
    );

    // Listener
    alb.addListener("HttpsListener", {
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [
        {
          certificateArn: config.ACMCertificateArn,
        },
      ],
      defaultTargetGroups: [targetGroup],
    });

    // Cluster
    const cluster = new Cluster(this, "WatanabeCluster", {
      clusterName: "WatanabeCluster",
      vpc: vpc,
    });

    // Log Group
    const logGroup = new LogGroup(this, "WatanabeLogGroup", {
      logGroupName: "watanabe-log-group",
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_DAY,
    });

    // Task Definition
    const taskDefinition = new FargateTaskDefinition(
      this,
      "WatanabeTaskDefinition",
      {
        cpu: 512,
        memoryLimitMiB: 1024,
      }
    );
    taskDefinition.addContainer("watanabeWeb", {
      image: webImage,
      containerName: "web",
      portMappings: [{ containerPort: 80 }],
      logging: LogDrivers.awsLogs({
        streamPrefix: "web",
        logGroup: logGroup,
      }),
    });
    taskDefinition.addContainer("watanabeApp", {
      image: appImage,
      containerName: "php-fpm",
      logging: LogDrivers.awsLogs({
        streamPrefix: "php-fpm",
        logGroup: logGroup,
      }),
      environment: {
        APP_KEY: config.appKey,
        APP_ENV: config.appEnv,
        APP_URL: config.appUrl,
        DB_PORT: db.dbInstanceEndpointPort.toString(),
        DB_HOST: db.dbInstanceEndpointAddress,
        DB_DATABASE: "watanabeDb",
        DB_CONNECTION: "pgsql",
        DB_USERNAME: "postgres",
        DB_PASSWORD: config.dbPassword,
      }
    });

    // Fargate Service
    const fargateService = new FargateService(this, "WatanabeFargateService", {
      cluster: cluster,
      serviceName: "WatanabeFargateService",
      taskDefinition: taskDefinition,
      desiredCount: 1,
      securityGroups: [fargateSg],
      platformVersion: FargatePlatformVersion.LATEST,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_ISOLATED,
      },
    });

    // Attach Target Group to Fargate Service
    fargateService.attachToApplicationTargetGroup(targetGroup);
  }
}
