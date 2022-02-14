import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { getStack } from '@pulumi/pulumi';

const config = new pulumi.Config();

async function provisionEC2() {
    const environment = getStack();
    const project = config.require('project');

    const vpc = await aws.ec2.getVpc({
        tags:{
            ['Name']:'custom-default-network'
        }
    });

    const subnets = await aws.ec2.getSubnetIds({
        vpcId: vpc.id, 
        tags:{
            ['Public']: '1'
        }
    });

    const customAMI = aws.ec2.getAmi({
        mostRecent: true,
        filters: [
            {
                name: 'name',
                values: [project],
            },
        ],
        owners: ['137130492928'],
    });

    const acm = await aws.acm.getCertificate({domain:'pulumi-test.com'})

    const securityGroup = new aws.ec2.SecurityGroup('securityGroup', {
        ingress: [
            { protocol: 'tcp', fromPort: 22, toPort: 22, cidrBlocks: ['0.0.0.0/0'] },
            { protocol: 'tcp', fromPort: 80, toPort: 80, cidrBlocks: ['0.0.0.0/0'] },
            { protocol: 'tcp', fromPort: 443, toPort: 443, cidrBlocks: ['0.0.0.0/0'] },
            { protocol: '-1', fromPort: 0, toPort: 0, self: true},
        ],
        egress: [
            { protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] },
        ],
        vpcId: vpc.id,
        name: `${project}-${environment}`,
        tags: {
            Environment: environment,
            Pulumi: 'true', 
        },

    });

    const userData = 
    `#!/bin/bash
    docker swarm init`;

    const ec2 = new aws.ec2.Instance('ec2', {
        ami: customAMI.then((customAMI: { id: string; }) => customAMI.id),
        instanceType: 't2.micro',
        rootBlockDevice: {
            deleteOnTermination: true,
            volumeType: 'gp3',
            volumeSize: 32
        },
        userData,
        keyName: 'pulumi-test',
        vpcSecurityGroupIds: [securityGroup.id],
        subnetId: subnets.ids[0],
        tags: {
            Name: `${project}-ec2-${environment}`,
            Environment: environment,
            Pulumi: 'true', 
        },
    });

    const alb = new aws.lb.LoadBalancer('alb', {
        internal: false,
        loadBalancerType: 'application',
        securityGroups: [securityGroup.id],
        subnets: subnets.ids.map((subnet: string) => subnet),
        enableDeletionProtection: false,
        tags: {
            Project: project,
            Environment: environment,
            Pulumi: 'true', 
        },
        name: `${project}-${environment}`
    });

    const targetGroup = new aws.lb.TargetGroup('albTargetGroup', {
        port: 80,
        protocol: 'HTTP',
        targetType: 'instance',
        vpcId: vpc.id,
        tags: {
            Project: project,
            Environment: environment,
            Pulumi: 'true', 
        },
        name: `${project}-${environment}`,
    },{
        dependsOn: [alb],
    });

    new aws.lb.TargetGroupAttachment('targetGroupAttachment', {
        targetGroupArn: targetGroup.arn,
        targetId: ec2.id,
    }, {
        dependsOn: [targetGroup],
    });

     new aws.lb.Listener('listener', {
        loadBalancerArn: alb.arn,
        port: 80,
        protocol: 'HTTP',
        defaultActions: [{
            type: 'redirect',
            redirect:
                {
                    statusCode: 'HTTP_301',
                    port: '443',
                    protocol: 'HTTPS',
                }
        }],
    });

    new aws.lb.Listener('listenerHTTPS', {
        loadBalancerArn: alb.arn,
        port: 443,
        protocol: 'HTTPS',
        sslPolicy: 'ELBSecurityPolicy-2016-08',
        certificateArn: acm.arn,
        defaultActions: [{
            type: 'forward',
            targetGroupArn: targetGroup.arn,
        }],
    });

    return {
        albAddress: alb.dnsName,
        ec2Address: ec2.publicDns,
    };
}

module.exports = (async function(){ 
    return await provisionEC2();
 })();

