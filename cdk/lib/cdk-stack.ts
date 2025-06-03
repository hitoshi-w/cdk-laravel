import { Stack, StackProps, RemovalPolicy, Duration } from "aws-cdk-lib";
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
  InstanceType,
  InstanceClass,
  InstanceSize,
} from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  FargatePlatformVersion,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  Protocol,
  TaskDefinitionRevision,
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { getConfig, IConfig } from "../config";
import { Repository } from "aws-cdk-lib/aws-ecr";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion } from "aws-cdk-lib/aws-rds";

dotenv.config();

export class CdkStack extends Stack {
  public readonly config: IConfig;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.config = getConfig();

    // Paramter Store
    new StringParameter(this, "AppKeyParameter", {
      parameterName: "/watanabe/app/key",
      stringValue: "WatanabeParameterValue",
    });

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
    // const dbSg = new SecurityGroup(this, "WatanabeDbSg", {
    //   vpc: vpc,
    //   securityGroupName: "WatanabeDbSg",
    // });
    // dbSg.addIngressRule(fargateSg, Port.tcp(5432));

    // // DB
    // const dbCredentials = Credentials.fromGeneratedSecret("postgres");
    // const db = new DatabaseInstance(this, "WatanabeDb", {
    //   vpc,
    //   vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
    //   engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_17 }),
    //   multiAz: false,
    //   securityGroups: [dbSg],
    //   credentials: dbCredentials,
    //   publiclyAccessible: false,
    //   removalPolicy: RemovalPolicy.DESTROY,
    //   deletionProtection: false,
    //   databaseName: "watanabe-db",
    // });

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
          certificateArn: this.config.ACMCertificateArn,
        },
      ],
      defaultTargetGroups: [targetGroup],
    });

    // ECR
    const appRepository = new Repository(this, "WatanabeAppRepository", {
      repositoryName: "watanabe-app",
    });
    const webRepository = new Repository(this, "WatanabeWebRepository", {
      repositoryName: "watanabe-web",
    });

    // Container Image from ECR
    const appImage = ContainerImage.fromEcrRepository(appRepository);
    const webImage = ContainerImage.fromEcrRepository(webRepository);

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
      containerName: "watanabe-web",
      portMappings: [{ containerPort: 80 }],
      logging: LogDrivers.awsLogs({
        streamPrefix: "web",
        logGroup: logGroup,
      }),
    });
    taskDefinition.addContainer("watanabeApp", {
      image: appImage,
      containerName: "watanabe-app",
      logging: LogDrivers.awsLogs({
        streamPrefix: "app",
        logGroup: logGroup,
      }),
      environment: {
        APP_KEY: this.config.appKey,
        APP_ENV: this.config.appEnv,
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
